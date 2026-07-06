import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as readline from 'readline';
import { nanoid } from 'nanoid';
export class UpstreamManager {
    upstreams = new Map();
    defaultNamespace = null;
    isStopping = false;
    onMessage;
    constructor(configPath, fallbackSingleUpstream) {
        this.loadConfig(configPath, fallbackSingleUpstream);
    }
    /**
     * Loads configurations from yaml or falls back to single-upstream options.
     */
    loadConfig(configPath, fallback) {
        const resolvedPath = configPath || path.resolve('undomcp.config.yaml');
        if (fs.existsSync(resolvedPath)) {
            try {
                const fileContent = fs.readFileSync(resolvedPath, 'utf8');
                const parsed = yaml.parse(fileContent);
                if (parsed && parsed.upstreams) {
                    const namespaces = Object.keys(parsed.upstreams);
                    for (const ns of namespaces) {
                        const def = parsed.upstreams[ns];
                        this.addUpstream(ns, {
                            command: def.command,
                            args: def.args || [],
                            env: def.env,
                            transport: def.transport || 'stdio'
                        });
                    }
                    if (namespaces.length > 0) {
                        this.defaultNamespace = namespaces[0];
                    }
                    return;
                }
            }
            catch (err) {
                console.error(`[undomcp] Error parsing config at ${resolvedPath}: ${err.message}`);
            }
        }
        // Fallback single-upstream
        if (fallback) {
            this.addUpstream('default', {
                command: fallback.command,
                args: fallback.args,
                transport: 'stdio'
            });
            this.defaultNamespace = 'default';
        }
    }
    addUpstream(namespace, definition) {
        this.upstreams.set(namespace, {
            namespace,
            definition,
            process: null,
            reader: null,
            pendingRequests: new Map()
        });
    }
    /**
     * Spawns all child processes.
     */
    start(agentStderr = process.stderr) {
        this.isStopping = false;
        for (const [ns, inst] of this.upstreams.entries()) {
            const def = inst.definition;
            const combinedEnv = { ...process.env, ...(def.env || {}) };
            const isWin = process.platform === 'win32';
            const cmd = isWin ? (process.env.COMSPEC || 'cmd.exe') : def.command;
            const args = isWin ? ['/d', '/s', '/c', def.command, ...def.args] : def.args;
            const proc = spawn(cmd, args, {
                env: combinedEnv,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            proc.on('error', (err) => {
                if (!this.isStopping) {
                    agentStderr.write(`[undomcp] Upstream process [${ns}] failed to start: ${err.message}\n`);
                }
            });
            proc.stderr?.on('data', (data) => {
                agentStderr.write(`[${ns}] ${data}`);
            });
            const reader = readline.createInterface({
                input: proc.stdout,
                output: undefined,
                historySize: 0
            });
            inst.process = proc;
            inst.reader = reader;
            reader.on('line', (line) => {
                if (!line.trim())
                    return;
                try {
                    const parsed = JSON.parse(line);
                    const isResponse = parsed && parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined);
                    if (isResponse) {
                        const resolver = inst.pendingRequests.get(parsed.id);
                        if (resolver) {
                            inst.pendingRequests.delete(parsed.id);
                            resolver(parsed);
                            return;
                        }
                    }
                    if (this.onMessage) {
                        this.onMessage(ns, parsed);
                    }
                }
                catch {
                    // Ignore parse errors on raw lines
                }
            });
        }
    }
    /**
     * Terminates all child processes.
     */
    stop() {
        this.isStopping = true;
        for (const inst of this.upstreams.values()) {
            try {
                inst.reader.close();
            }
            catch { }
            if (inst.process) {
                inst.process.kill('SIGTERM');
            }
        }
    }
    /**
     * Lists tools from all upstreams, applying namespacing where appropriate.
     */
    async listAllTools() {
        const promises = Array.from(this.upstreams.entries()).map(async ([ns, inst]) => {
            try {
                const response = await this.callUpstreamDirect(ns, 'tools/list', {});
                if (response && response.result && Array.isArray(response.result.tools)) {
                    const tools = response.result.tools;
                    // Apply namespace double underscore mapping if there is more than 1 upstream or not default
                    if (this.upstreams.size > 1 || ns !== 'default') {
                        return tools.map((t) => ({
                            ...t,
                            name: `${ns}__${t.name}`
                        }));
                    }
                    return tools;
                }
            }
            catch (err) {
                console.error(`[undomcp] Failed listing tools for namespace [${ns}]: ${err.message}`);
            }
            return [];
        });
        const results = await Promise.all(promises);
        return results.flat();
    }
    /**
     * Send a JSON-RPC request to a specific upstream by namespace.
     */
    async callUpstreamDirect(namespace, method, params, customId) {
        const inst = this.upstreams.get(namespace);
        if (!inst || !inst.process) {
            throw new Error(`Upstream namespace "${namespace}" is not running or defined.`);
        }
        return new Promise((resolve, reject) => {
            const id = customId !== undefined ? customId : `up_${nanoid()}`;
            inst.pendingRequests.set(id, (res) => resolve(res));
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };
            if (inst.process.stdin && !inst.process.stdin.destroyed) {
                inst.process.stdin.write(JSON.stringify(request) + '\n');
            }
            else {
                inst.pendingRequests.delete(id);
                reject(new Error(`Upstream process [${namespace}] stdin is closed.`));
            }
        });
    }
    /**
     * Routes a Namespaced tool call to the correct upstream process.
     */
    async routeCall(toolName, args, customId) {
        const parts = toolName.split('__');
        let ns = this.defaultNamespace || 'default';
        let baseToolName = toolName;
        if (parts.length > 1 && this.upstreams.has(parts[0])) {
            ns = parts[0];
            baseToolName = parts[1];
        }
        return this.callUpstreamDirect(ns, 'tools/call', {
            name: baseToolName,
            arguments: args
        }, customId);
    }
    getUpstreamInstance(namespace) {
        return this.upstreams.get(namespace);
    }
    getNamespaces() {
        return Array.from(this.upstreams.keys());
    }
    isMultiUpstream() {
        return this.upstreams.size > 1 || (this.upstreams.size === 1 && !this.upstreams.has('default'));
    }
    /**
     * Broadcasts a JSON-RPC request to all running upstream servers.
     * If the method is 'initialize', merges the capabilities and server details.
     */
    async broadcast(method, params, customId) {
        const namespaces = this.getNamespaces();
        if (namespaces.length === 0) {
            throw new Error('No upstream servers configured.');
        }
        const promises = namespaces.map(async (ns) => {
            try {
                return await this.callUpstreamDirect(ns, method, params, customId);
            }
            catch (err) {
                console.error(`[undomcp] Broadcast failed for namespace [${ns}]: ${err.message}`);
                return null;
            }
        });
        const responses = (await Promise.all(promises)).filter(Boolean);
        if (responses.length === 0) {
            throw new Error(`Broadcast request "${method}" failed on all upstream servers.`);
        }
        if (method === 'initialize') {
            const combinedCapabilities = {};
            const serverNames = [];
            let protocolVersion = '2024-11-05';
            for (const res of responses) {
                if (res && res.result) {
                    const result = res.result;
                    if (result.protocolVersion) {
                        protocolVersion = result.protocolVersion;
                    }
                    if (result.capabilities) {
                        Object.assign(combinedCapabilities, result.capabilities);
                    }
                    if (result.serverInfo && result.serverInfo.name) {
                        serverNames.push(result.serverInfo.name);
                    }
                }
            }
            return {
                jsonrpc: '2.0',
                id: customId,
                result: {
                    protocolVersion,
                    capabilities: combinedCapabilities,
                    serverInfo: {
                        name: `undomcp-proxy[${serverNames.join(', ')}]`,
                        version: '1.0.0'
                    }
                }
            };
        }
        // Default: return response from default namespace, or the first successful response
        const defaultRes = responses.find((res, i) => namespaces[i] === this.defaultNamespace);
        return defaultRes || responses[0];
    }
}
