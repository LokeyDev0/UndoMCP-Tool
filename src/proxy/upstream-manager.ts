import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as readline from 'readline';
import { Readable, Writable } from 'stream';
import { nanoid } from 'nanoid';
import { HttpUpstreamClient } from './http-upstream-client.js';

export interface UpstreamDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport: 'stdio' | 'http' | 'sse' | 'ws';
  url?: string;
  headers?: Record<string, string>;
}

export interface UpstreamInstance {
  namespace: string;
  definition: UpstreamDefinition;
  process: ChildProcess | null;
  reader: readline.Interface | null;
  httpClient?: HttpUpstreamClient;
  pendingRequests: Map<string | number, (response: any) => void>;
  exitCode?: number | null;
  signal?: string | null;
  stderrBuffer?: string[];
  spawnError?: Error;
}

export class UpstreamManager {
  private upstreams = new Map<string, UpstreamInstance>();
  private defaultNamespace: string | null = null;
  private isStopping = false;
  
  public onMessage?: (namespace: string, parsedMessage: any) => void;

  constructor(configPath?: string, fallbackSingleUpstream?: { command: string; args: string[] }) {
    this.loadConfig(configPath, fallbackSingleUpstream);
  }


  /**
   * Loads configurations from yaml or falls back to single-upstream options.
   */
  private loadConfig(configPath?: string, fallback?: { command: string; args: string[] }): void {
    const resolvedPath = configPath || path.resolve('undomcp.config.yaml');

    if (fs.existsSync(resolvedPath)) {
      try {
        const fileContent = fs.readFileSync(resolvedPath, 'utf8');
        const parsed = yaml.parse(fileContent);
        if (parsed && parsed.upstreams) {
          const namespaces = Object.keys(parsed.upstreams);
          for (const ns of namespaces) {
            const def = parsed.upstreams[ns];
            const transport = def.transport || (def.url ? 'http' : 'stdio');
            this.addUpstream(ns, {
              command: def.command,
              args: def.args || [],
              env: def.env,
              transport,
              url: def.url,
              headers: def.headers,
            });
          }
          if (namespaces.length > 0) {
            this.defaultNamespace = namespaces[0];
          }
          return;
        }
      } catch (err: any) {
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

  private addUpstream(namespace: string, definition: UpstreamDefinition): void {
    this.upstreams.set(namespace, {
      namespace,
      definition,
      process: null,
      reader: null,
      pendingRequests: new Map(),
      exitCode: null,
      signal: null,
      stderrBuffer: [],
      spawnError: undefined
    });
  }

  public registerHttpUpstream(namespace: string, url: string, transport: 'http' | 'sse' | 'ws', headers?: Record<string, string>): void {
    this.addUpstream(namespace, { transport, url, headers });
    if (!this.defaultNamespace) {
      this.defaultNamespace = namespace;
    }
  }

  /**
   * Spawns all child processes and initializes HTTP clients.
   */
  public start(agentStderr: Writable = process.stderr): void {
    this.isStopping = false;

    for (const [ns, inst] of this.upstreams.entries()) {
      const def = inst.definition;

      if (def.transport !== 'stdio') {
        // HTTP/SSE/WS transport — initialize HTTP client
        if (def.url) {
          inst.httpClient = new HttpUpstreamClient({
            url: def.url,
            transport: def.transport === 'sse' ? 'sse' : def.transport === 'ws' ? 'ws' : 'http',
            defaultHeaders: def.headers,
          });
        }
        continue;
      }

      // stdio transport — spawn child process
      if (!def.command) continue;

      const combinedEnv = { ...process.env, ...(def.env || {}) } as Record<string, string>;

      const isWin = process.platform === 'win32';
      const cmd = isWin ? (process.env.COMSPEC || 'cmd.exe') : def.command;
      const args = isWin ? ['/d', '/s', '/c', def.command, ...(def.args || [])] : (def.args || []);

      inst.exitCode = null;
      inst.signal = null;
      inst.stderrBuffer = [];
      inst.spawnError = undefined;

      const proc = spawn(cmd, args, {
        env: combinedEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      proc.on('error', (err) => {
        inst.spawnError = err;
        if (!this.isStopping) {
          agentStderr.write(`[undomcp] Upstream process [${ns}] failed to start: ${err.message}\n`);
        }
      });

      proc.on('exit', (code, signal) => {
        inst.exitCode = code;
        inst.signal = signal;
      });

      proc.stderr?.on('data', (data) => {
        const str = data.toString();
        agentStderr.write(`[${ns}] ${str}`);
        if (!inst.stderrBuffer) {
          inst.stderrBuffer = [];
        }
        inst.stderrBuffer.push(str);
        if (inst.stderrBuffer.length > 20) {
          inst.stderrBuffer.shift();
        }
      });

      inst.process = proc;

      if (proc.stdout) {
        const reader = readline.createInterface({
          input: proc.stdout,
          output: undefined,
          historySize: 0
        });
        inst.reader = reader;

        reader.on('line', (line) => {
          if (!line.trim()) return;
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
          } catch {
            // Ignore parse errors on raw lines
          }
        });
      }
    }
  }

  /**
   * Terminates all child processes and closes HTTP clients.
   */
  public stop(): void {
    this.isStopping = true;
    for (const inst of this.upstreams.values()) {
      try {
        if (inst.reader) {
          inst.reader.close();
        }
      } catch {}
      if (inst.process) {
        inst.process.kill('SIGTERM');
      }
      if (inst.httpClient) {
        inst.httpClient.close();
      }
    }
  }

  /**
   * Lists tools from all upstreams, applying namespacing where appropriate.
   */
  public async listAllTools(): Promise<any[]> {
    if (this.upstreams.size === 0) return [];

    const promises = Array.from(this.upstreams.entries()).map(async ([ns, inst]) => {
      const response = await this.callUpstreamDirect(ns, 'tools/list', {});
      if (response && response.result && Array.isArray(response.result.tools)) {
        const tools = response.result.tools;
        // Apply namespace double underscore mapping if there is more than 1 upstream or not default
        if (this.upstreams.size > 1 || ns !== 'default') {
          return tools.map((t: any) => ({
            ...t,
            name: `${ns}__${t.name}`
          }));
        }
        return tools;
      }
      throw new Error(`Upstream [${ns}] returned invalid tools response`);
    });

    const results = await Promise.all(promises);
    return results.flat();
  }

  /**
   * Send a JSON-RPC request to a specific upstream by namespace.
   */
  public async callUpstreamDirect(namespace: string, method: string, params: any, customId?: string | number, timeoutMs?: number): Promise<any> {
    const inst = this.upstreams.get(namespace);
    if (!inst) {
      throw new Error(`Upstream namespace "${namespace}" is not defined.`);
    }

    // HTTP transport path
    if (inst.definition.transport !== 'stdio' && inst.httpClient) {
      const id = customId !== undefined ? customId : `up_${nanoid()}`;
      const request = { jsonrpc: '2.0', id, method, params };
      const result = await inst.httpClient.forwardRequest(request, inst.definition.headers || {});
      return result.body;
    }

    // stdio transport path
    if (inst.spawnError) {
      throw new Error(`Upstream [${namespace}] failed to start: ${inst.spawnError.message}`);
    }

    if (inst.exitCode !== null && inst.exitCode !== undefined) {
      const lastStderr = inst.stderrBuffer?.join('').trim() || '';
      const stderrMsg = lastStderr ? `\nStderr output:\n${lastStderr}` : '';
      throw new Error(`Upstream [${namespace}] exited with code ${inst.exitCode}${inst.signal ? ` (signal ${inst.signal})` : ''}.${stderrMsg}`);
    }

    if (!inst.process) {
      throw new Error(`Upstream namespace "${namespace}" is not running.`);
    }

    const effectiveTimeout = timeoutMs ?? 60000; // Default 60s timeout

    return new Promise((resolve, reject) => {
      const id = customId !== undefined ? customId : `up_${nanoid()}`;

      const timer = setTimeout(() => {
        inst.pendingRequests.delete(id);
        reject(new Error(`Upstream [${namespace}] timed out after ${effectiveTimeout}ms for method "${method}"`));
      }, effectiveTimeout);

      inst.pendingRequests.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      if (inst.process && inst.process.stdin && !inst.process.stdin.destroyed) {
        inst.process.stdin.write(JSON.stringify(request) + '\n');
      } else {
        clearTimeout(timer);
        inst.pendingRequests.delete(id);

        // Re-check exit code in case it died right now
        if (inst.exitCode !== null && inst.exitCode !== undefined) {
          const lastStderr = inst.stderrBuffer?.join('').trim() || '';
          const stderrMsg = lastStderr ? `\nStderr output:\n${lastStderr}` : '';
          reject(new Error(`Upstream [${namespace}] exited with code ${inst.exitCode}${inst.signal ? ` (signal ${inst.signal})` : ''}.${stderrMsg}`));
        } else {
          reject(new Error(`Upstream process [${namespace}] stdin is closed.`));
        }
      }
    });
  }

  /**
   * Routes a Namespaced tool call to the correct upstream process.
   */
  public async routeCall(toolName: string, args: any, customId?: string | number): Promise<any> {
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

  public getUpstreamInstance(namespace: string): UpstreamInstance | undefined {
    return this.upstreams.get(namespace);
  }

  public getNamespaces(): string[] {
    return Array.from(this.upstreams.keys());
  }

  public isMultiUpstream(): boolean {
    return this.upstreams.size > 1 || (this.upstreams.size === 1 && !this.upstreams.has('default'));
  }

  /**
   * Broadcasts a JSON-RPC request to all running upstream servers.
   * If the method is 'initialize', merges the capabilities and server details.
   */
  public async broadcast(method: string, params: any, customId?: string | number): Promise<any> {
    const namespaces = this.getNamespaces();
    if (namespaces.length === 0) {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: customId,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'undomcp-standalone',
              version: '1.0.0'
            }
          }
        };
      }
      throw new Error('No upstream servers configured.');
    }

    const promises = namespaces.map(async (ns) => {
      try {
        return await this.callUpstreamDirect(ns, method, params, customId);
      } catch (err: any) {
        console.error(`[undomcp] Broadcast failed for namespace [${ns}]: ${err.message}`);
        return null;
      }
    });

    const responses = (await Promise.all(promises)).filter(Boolean);

    if (responses.length === 0) {
      throw new Error(`Broadcast request "${method}" failed on all upstream servers.`);
    }

    if (method === 'initialize') {
      const combinedCapabilities: Record<string, any> = {};
      const serverNames: string[] = [];
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
