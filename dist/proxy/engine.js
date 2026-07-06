import * as readline from 'readline';
import { nanoid } from 'nanoid';
import { UpstreamManager } from './upstream-manager.js';
import { UNDO_TOOLS, handleListHistory } from '../tools/undo-tools.js';
export class ProxyEngine {
    command;
    args;
    env;
    isStopping = false;
    onRequestCallback;
    onResponseCallback;
    dbManager;
    sessionId;
    turnId;
    nextSequenceNum = 1;
    turnIdleTimeoutMs = 180000; // default 3 minutes
    lastActionEndTime;
    upstreamManager;
    activeRequests = new Map();
    agentReader;
    constructor(options) {
        this.command = options.command;
        this.args = options.args;
        this.env = { ...process.env, ...(options.env || {}) };
        this.onRequestCallback = options.onRequest;
        this.onResponseCallback = options.onResponse;
        this.dbManager = options.dbManager;
        this.sessionId = options.sessionId;
        this.turnId = options.turnId;
        if (options.turnIdleTimeoutMs !== undefined) {
            this.turnIdleTimeoutMs = options.turnIdleTimeoutMs;
        }
        if (this.dbManager && this.sessionId) {
            try {
                const actions = this.dbManager.getActionsForSession(this.sessionId);
                if (actions.length > 0) {
                    const maxSeq = Math.max(...actions.map(a => a.sequenceNum));
                    this.nextSequenceNum = maxSeq + 1;
                }
            }
            catch (err) {
                console.error(`[undomcp] Error initializing sequence number: ${err.message}`);
            }
        }
        this.upstreamManager = new UpstreamManager(options.configPath, {
            command: this.command,
            args: this.args
        });
    }
    /**
     * Starts the proxy engine by spawning the upstream processes and connecting streams.
     */
    start(agentStdin = process.stdin, agentStdout = process.stdout, agentStderr = process.stderr) {
        this.isStopping = false;
        // Start all configured upstreams
        this.upstreamManager.start(agentStderr);
        // Forward upstream messages (not parsed by pending promises) to the agent
        this.upstreamManager.onMessage = (ns, msg) => {
            this.forwardToAgent(JSON.stringify(msg), agentStdout);
        };
        // Create line-by-line reader for agent input
        this.agentReader = readline.createInterface({
            input: agentStdin,
            output: undefined,
            historySize: 0,
        });
        // Process agent requests -> upstream
        this.agentReader.on('line', (line) => {
            this.handleAgentLine(line, agentStdout);
        });
        // Setup signal forwarding
        this.setupSignalHandlers();
    }
    /**
     * Stops the proxy engine and terminates the child processes.
     */
    stop() {
        this.isStopping = true;
        this.cleanup();
        this.upstreamManager.stop();
    }
    cleanup() {
        try {
            this.agentReader.close();
        }
        catch {
            // Ignore cleanup failures
        }
    }
    setupSignalHandlers() {
        const forwardSignal = () => {
            this.upstreamManager.stop();
        };
        process.on('SIGINT', () => forwardSignal());
        process.on('SIGTERM', () => forwardSignal());
    }
    async handleMarkTurn(request, agentStdout) {
        if (this.dbManager && this.sessionId) {
            try {
                const promptText = request.params?.arguments?.prompt_text || '';
                const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
                const nextTurnNum = lastTurn ? lastTurn.turnNum + 1 : 1;
                const turnId = `turn_${nanoid()}`;
                this.dbManager.createTurn({
                    id: turnId,
                    sessionId: this.sessionId,
                    turnNum: nextTurnNum,
                    promptText,
                    timestamp: new Date().toISOString(),
                    actionCount: 0
                });
                this.turnId = turnId;
                this.lastActionEndTime = Date.now();
            }
            catch (err) {
                console.error(`[undomcp] Database error in undomcp_mark_turn: ${err.message}`);
            }
        }
        const response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
                content: [
                    {
                        type: 'text',
                        text: 'Turn marked successfully.'
                    }
                ]
            }
        };
        this.forwardToAgent(JSON.stringify(response), agentStdout);
    }
    async handleAgentLine(line, agentStdout) {
        if (!line.trim())
            return;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // If not valid JSON, forward it to default upstream
            const defNs = this.upstreamManager.getNamespaces()[0] || 'default';
            this.upstreamManager.getUpstreamInstance(defNs)?.process.stdin?.write(line + '\n');
            return;
        }
        const isRequest = parsed && parsed.id !== undefined && parsed.method !== undefined;
        if (isRequest) {
            if (parsed.method === 'tools/list') {
                if (this.onRequestCallback) {
                    try {
                        await this.onRequestCallback(parsed);
                    }
                    catch (err) {
                        console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
                    }
                }
                try {
                    const allTools = await this.upstreamManager.listAllTools();
                    const aggregatedTools = [...allTools, ...UNDO_TOOLS];
                    const response = {
                        jsonrpc: '2.0',
                        id: parsed.id,
                        result: {
                            tools: aggregatedTools
                        }
                    };
                    if (this.onResponseCallback) {
                        try {
                            await this.onResponseCallback(parsed, response);
                        }
                        catch (err) {
                            console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
                        }
                    }
                    this.forwardToAgent(JSON.stringify(response), agentStdout);
                }
                catch (err) {
                    const response = {
                        jsonrpc: '2.0',
                        id: parsed.id,
                        error: {
                            code: -32603,
                            message: `Failed listing upstream tools: ${err.message}`
                        }
                    };
                    if (this.onResponseCallback) {
                        try {
                            await this.onResponseCallback(parsed, response);
                        }
                        catch (err) {
                            console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
                        }
                    }
                    this.forwardToAgent(JSON.stringify(response), agentStdout);
                }
                return;
            }
            if (parsed.method === 'tools/call') {
                const toolName = parsed.params?.name || '';
                if (toolName.startsWith('undomcp_')) {
                    await this.handleUndoToolCall(parsed, agentStdout);
                    return;
                }
                // Journaling tool call — log all MCP calls for full audit trail
                let actionId;
                const startTime = Date.now();
                const parts = toolName.split('__');
                const namespace = parts.length > 1 ? parts[0] : undefined;
                const baseToolName = parts.length > 1 ? parts[1] : toolName;
                if (this.dbManager && this.sessionId) {
                    try {
                        // Turn clustering
                        this.ensureActiveTurnId();
                        actionId = `act_${nanoid()}`;
                        const args = parsed.params?.arguments || {};
                        let label = `Call ${toolName}`;
                        if (baseToolName === 'write_file' || baseToolName === 'edit_file' || baseToolName === 'replace_file_content' || baseToolName === 'write_to_file') {
                            const filePath = args.path || args.TargetFile || args.filePath || '';
                            label = `Modify file: ${filePath}`;
                        }
                        else if (baseToolName === 'run_command' || baseToolName === 'execute_command') {
                            const command = args.command || args.CommandLine || '';
                            label = `Execute command: ${command}`;
                        }
                        else if (args.path || args.file || args.filename) {
                            const pathVal = args.path || args.file || args.filename;
                            label = `${baseToolName} on ${pathVal}`;
                        }
                        else if (args.id || args.name) {
                            const idVal = args.id || args.name;
                            label = `${baseToolName} (${idVal})`;
                        }
                        const action = {
                            id: actionId,
                            sessionId: this.sessionId,
                            turnId: this.turnId,
                            sequenceNum: this.nextSequenceNum++,
                            timestamp: new Date(startTime).toISOString(),
                            actionType: 'mcp_call',
                            toolName: baseToolName,
                            namespace,
                            parameters: args,
                            state: 'executed',
                            metadata: { label }
                        };
                        this.dbManager.createAction(action);
                    }
                    catch (err) {
                        console.error(`[undomcp] Database error in pre-action logging: ${err.message}`);
                    }
                }
                if (this.onRequestCallback) {
                    try {
                        await this.onRequestCallback(parsed);
                    }
                    catch (err) {
                        console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
                    }
                }
                // Forward call upstream and wait for response
                try {
                    const response = await this.upstreamManager.routeCall(toolName, parsed.params.arguments, parsed.id);
                    this.lastActionEndTime = Date.now();
                    // Journal response
                    if (this.dbManager && actionId) {
                        try {
                            const latencyMs = Date.now() - startTime;
                            const hasRpcError = response.error !== undefined;
                            const hasMcpError = response.result && response.result.isError === true;
                            const success = !hasRpcError && !hasMcpError;
                            const resultData = response.result || response.error || {};
                            this.dbManager.updateActionResults(actionId, success, resultData, latencyMs);
                        }
                        catch (err) {
                            console.error(`[undomcp] Database error in post-action logging: ${err.message}`);
                        }
                    }
                    if (this.onResponseCallback) {
                        try {
                            await this.onResponseCallback(parsed, response);
                        }
                        catch (err) {
                            console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
                        }
                    }
                    // Send response back to agent
                    this.forwardToAgent(JSON.stringify(response), agentStdout);
                }
                catch (err) {
                    const response = {
                        jsonrpc: '2.0',
                        id: parsed.id,
                        error: {
                            code: -32603,
                            message: `Call execution failed upstream: ${err.message}`
                        }
                    };
                    this.forwardToAgent(JSON.stringify(response), agentStdout);
                }
                return;
            }
            // Lifecycle call (e.g. initialize)
            if (this.onRequestCallback) {
                try {
                    await this.onRequestCallback(parsed);
                }
                catch (err) {
                    console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
                }
            }
            try {
                const response = await this.upstreamManager.broadcast(parsed.method, parsed.params, parsed.id);
                if (this.onResponseCallback) {
                    try {
                        await this.onResponseCallback(parsed, response);
                    }
                    catch (err) {
                        console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
                    }
                }
                this.forwardToAgent(JSON.stringify(response), agentStdout);
            }
            catch (err) {
                const response = {
                    jsonrpc: '2.0',
                    id: parsed.id,
                    error: {
                        code: -32603,
                        message: `Broadcast request failed: ${err.message}`
                    }
                };
                if (this.onResponseCallback) {
                    try {
                        await this.onResponseCallback(parsed, response);
                    }
                    catch (err) {
                        console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
                    }
                }
                this.forwardToAgent(JSON.stringify(response), agentStdout);
            }
        }
        else {
            // Notification
            for (const ns of this.upstreamManager.getNamespaces()) {
                this.upstreamManager.callUpstreamDirect(ns, parsed.method, parsed.params, undefined).catch(() => { });
            }
        }
    }
    async handleUndoToolCall(request, agentStdout) {
        const toolName = request.params?.name;
        const args = request.params?.arguments || {};
        let result;
        let error;
        if (toolName === 'undomcp_mark_turn') {
            await this.handleMarkTurn(request, agentStdout);
            return;
        }
        if (!this.dbManager || !this.sessionId) {
            error = {
                code: -32603,
                message: 'DatabaseManager or Session ID is not configured on the proxy.'
            };
        }
        else {
            try {
                if (toolName === 'undomcp_list_history') {
                    const limit = args.limit !== undefined ? Number(args.limit) : 10;
                    // Get working directory from the current session for project-scoped query
                    const session = this.dbManager.getSession(this.sessionId);
                    const workingDir = session?.workingDirectory || process.cwd();
                    const list = handleListHistory(this.dbManager, workingDir, limit);
                    result = { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
                }
                else {
                    error = {
                        code: -32601,
                        message: `Method not found: ${toolName}`
                    };
                }
            }
            catch (err) {
                error = {
                    code: -32603,
                    message: err.message
                };
            }
        }
        const response = {
            jsonrpc: '2.0',
            id: request.id,
            ...(error ? { error } : { result })
        };
        this.forwardToAgent(JSON.stringify(response), agentStdout);
    }
    forwardToAgent(line, agentStdout) {
        if (!agentStdout.destroyed) {
            agentStdout.write(line + '\n');
        }
    }
    ensureActiveTurnId() {
        if (!this.dbManager || !this.sessionId) {
            throw new Error('DatabaseManager and SessionId must be initialized');
        }
        if (this.lastActionEndTime === undefined) {
            const lastActionTimeStr = this.dbManager.getLastActionTimestampForSession(this.sessionId);
            if (lastActionTimeStr) {
                this.lastActionEndTime = Date.parse(lastActionTimeStr);
            }
        }
        const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
        if (!this.turnId) {
            if (lastTurn) {
                if (this.lastActionEndTime !== undefined && (Date.now() - this.lastActionEndTime > this.turnIdleTimeoutMs)) {
                    const nextTurnNum = lastTurn.turnNum + 1;
                    this.turnId = `turn_${nanoid()}`;
                    this.dbManager.createTurn({
                        id: this.turnId,
                        sessionId: this.sessionId,
                        turnNum: nextTurnNum,
                        timestamp: new Date().toISOString(),
                        actionCount: 0
                    });
                }
                else {
                    this.turnId = lastTurn.id;
                }
            }
            else {
                this.turnId = `turn_${nanoid()}`;
                this.dbManager.createTurn({
                    id: this.turnId,
                    sessionId: this.sessionId,
                    turnNum: 1,
                    timestamp: new Date().toISOString(),
                    actionCount: 0
                });
            }
        }
        else {
            if (lastTurn && this.lastActionEndTime !== undefined && (Date.now() - this.lastActionEndTime > this.turnIdleTimeoutMs)) {
                const nextTurnNum = lastTurn.turnNum + 1;
                this.turnId = `turn_${nanoid()}`;
                this.dbManager.createTurn({
                    id: this.turnId,
                    sessionId: this.sessionId,
                    turnNum: nextTurnNum,
                    timestamp: new Date().toISOString(),
                    actionCount: 0
                });
            }
        }
        return this.turnId;
    }
}
