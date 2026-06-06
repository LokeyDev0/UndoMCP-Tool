import { spawn } from 'child_process';
import * as readline from 'readline';
import { SchemaCache } from '../undo/schema-cache.js';
import { nanoid } from 'nanoid';
import { SnapshotStore } from '../file-safety/snapshot-store.js';
import { InverseResolver } from '../undo/inverse-resolver.js';
import { UndoController } from '../undo/undo-controller.js';
import { LlmSolver } from '../undo/llm-solver.js';
import { UNDO_TOOLS, handleInteractive, handleListTurns, handlePreviewUndo, handleUndoSelection } from '../tools/undo-tools.js';
export class ProxyEngine {
    command;
    args;
    env;
    childProcess = null;
    isStopping = false;
    onRequestCallback;
    onResponseCallback;
    dbManager;
    sessionId;
    turnId;
    nextSequenceNum = 1;
    turnIdleTimeoutMs = 180000; // default 3 minutes
    lastActionEndTime;
    schemaCache = new SchemaCache();
    undoController = null;
    pendingCompensations = new Map();
    // Track active requests by their JSON-RPC ID to map responses back
    activeRequests = new Map();
    agentReader;
    upstreamReader;
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
        if (this.dbManager) {
            const snapshotStore = new SnapshotStore(this.dbManager);
            const inverseResolver = new InverseResolver(this.schemaCache);
            let llmSolver;
            const llmEnabled = process.env.UNDOMCP_LLM_ENABLED === 'true';
            if (llmEnabled) {
                llmSolver = new LlmSolver({
                    enabled: true,
                    endpoint: process.env.UNDOMCP_LLM_ENDPOINT,
                    model: process.env.UNDOMCP_LLM_MODEL,
                    apiKey: process.env.UNDOMCP_LLM_API_KEY
                });
            }
            this.undoController = new UndoController(this.dbManager, snapshotStore, this.schemaCache, inverseResolver, llmSolver);
        }
    }
    /**
     * Updates the active turn ID dynamically.
     */
    setTurnId(turnId) {
        this.turnId = turnId;
    }
    /**
     * Returns the schema cache, populated from upstream tools/list responses.
     */
    getSchemaCache() {
        return this.schemaCache;
    }
    /**
     * Starts the proxy engine by spawning the upstream process and connecting streams.
     */
    start(agentStdin = process.stdin, agentStdout = process.stdout, agentStderr = process.stderr) {
        this.isStopping = false;
        // Spawn upstream process
        this.childProcess = spawn(this.command, this.args, {
            env: this.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Handle upstream errors
        this.childProcess.on('error', (err) => {
            if (!this.isStopping) {
                agentStderr.write(`[undomcp] Upstream process failed to start: ${err.message}\n`);
                process.exit(1);
            }
        });
        // Pipe upstream stderr directly to agent stderr for debug logs
        this.childProcess.stderr?.on('data', (data) => {
            agentStderr.write(data);
        });
        // Handle upstream process exit
        this.childProcess.on('exit', (code, signal) => {
            this.cleanup();
            if (this.isStopping)
                return;
            if (code !== null) {
                process.exit(code);
            }
            else if (signal) {
                process.exit(1);
            }
        });
        // Create line-by-line readers
        this.agentReader = readline.createInterface({
            input: agentStdin,
            output: undefined,
            historySize: 0,
        });
        this.upstreamReader = readline.createInterface({
            input: this.childProcess.stdout,
            output: undefined,
            historySize: 0,
        });
        // Process agent requests -> upstream
        this.agentReader.on('line', (line) => {
            this.handleAgentLine(line, agentStdout);
        });
        // Process upstream responses -> agent
        this.upstreamReader.on('line', (line) => {
            this.handleUpstreamLine(line, agentStdout);
        });
        // Setup signal forwarding
        this.setupSignalHandlers();
    }
    /**
     * Stops the proxy engine and terminates the child process.
     */
    stop() {
        this.isStopping = true;
        this.cleanup();
        if (this.childProcess) {
            this.childProcess.kill('SIGTERM');
            this.childProcess = null;
        }
    }
    cleanup() {
        try {
            this.agentReader.close();
            this.upstreamReader.close();
        }
        catch {
            // Ignore cleanup failures
        }
    }
    setupSignalHandlers() {
        const forwardSignal = (signal) => {
            if (this.childProcess) {
                this.childProcess.kill(signal);
            }
        };
        process.on('SIGINT', () => forwardSignal('SIGINT'));
        process.on('SIGTERM', () => forwardSignal('SIGTERM'));
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
            // If not valid JSON, forward it as-is to let upstream handle/fail
            this.forwardToUpstream(line);
            return;
        }
        // Check if it's a request (has id and method)
        const isRequest = parsed && parsed.id !== undefined && parsed.method !== undefined;
        if (isRequest) {
            if (parsed.method === 'tools/call') {
                const toolName = parsed.params?.name || '';
                if (toolName.startsWith('undomcp_')) {
                    await this.handleUndoToolCall(parsed, agentStdout);
                    return;
                }
            }
            let actionId;
            const startTime = Date.now();
            // Database journaling hook for tool calls
            if (this.dbManager && this.sessionId && parsed.method === 'tools/call') {
                try {
                    const toolName = parsed.params?.name || '';
                    const parts = toolName.split('__');
                    const namespace = parts.length > 1 ? parts[0] : undefined;
                    const baseToolName = parts.length > 1 ? parts[1] : toolName;
                    // Resolve turn clustering
                    if (!this.turnId) {
                        const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
                        if (lastTurn) {
                            if (this.lastActionEndTime === undefined) {
                                const lastActionTimeStr = this.dbManager.getLastActionTimestampForSession(this.sessionId);
                                if (lastActionTimeStr) {
                                    this.lastActionEndTime = Date.parse(lastActionTimeStr);
                                }
                            }
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
                        if (this.lastActionEndTime === undefined) {
                            const lastActionTimeStr = this.dbManager.getLastActionTimestampForSession(this.sessionId);
                            if (lastActionTimeStr) {
                                this.lastActionEndTime = Date.parse(lastActionTimeStr);
                            }
                        }
                        if (this.lastActionEndTime !== undefined && (Date.now() - this.lastActionEndTime > this.turnIdleTimeoutMs)) {
                            const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
                            const nextTurnNum = lastTurn ? lastTurn.turnNum + 1 : 1;
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
                    actionId = `act_${nanoid()}`;
                    // Generate human-readable label
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
            this.activeRequests.set(parsed.id, { request: parsed, actionId, startTime });
            if (this.onRequestCallback) {
                try {
                    await this.onRequestCallback(parsed);
                }
                catch (err) {
                    console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
                }
            }
        }
        this.forwardToUpstream(line);
    }
    async handleUpstreamLine(line, agentStdout) {
        if (!line.trim())
            return;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // Forward as-is
            this.forwardToAgent(line, agentStdout);
            return;
        }
        // Check if it's a response matching an active request or a compensation
        const isResponse = parsed && parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined);
        if (isResponse) {
            const activeComp = this.pendingCompensations.get(parsed.id);
            if (activeComp) {
                this.pendingCompensations.delete(parsed.id);
                activeComp(parsed);
                return; // swallow response to proxy-initiated compensating call
            }
            const activeReq = this.activeRequests.get(parsed.id);
            if (activeReq) {
                this.activeRequests.delete(parsed.id);
                this.lastActionEndTime = Date.now();
                const { request: originalRequest, actionId, startTime } = activeReq;
                // Populate schema cache from tools/list responses
                if (originalRequest.method === 'tools/list' && parsed.result) {
                    try {
                        this.schemaCache.updateFromToolsList(parsed.result);
                    }
                    catch (err) {
                        console.error(`[undomcp] Error caching tool schemas: ${err.message}`);
                    }
                    if (Array.isArray(parsed.result.tools)) {
                        parsed.result.tools = [...parsed.result.tools, ...UNDO_TOOLS];
                        line = JSON.stringify(parsed);
                    }
                }
                // Database journaling hook for responses
                if (this.dbManager && actionId) {
                    try {
                        const endTime = Date.now();
                        const latencyMs = endTime - startTime;
                        // Check success/failure
                        const hasRpcError = parsed.error !== undefined;
                        const hasMcpError = parsed.result && parsed.result.isError === true;
                        const success = !hasRpcError && !hasMcpError;
                        // Extract result data: result or error details
                        const resultData = parsed.result || parsed.error || {};
                        this.dbManager.updateActionResults(actionId, success, resultData, latencyMs);
                    }
                    catch (err) {
                        console.error(`[undomcp] Database error in post-action logging: ${err.message}`);
                    }
                }
                if (this.onResponseCallback) {
                    try {
                        await this.onResponseCallback(originalRequest, parsed);
                    }
                    catch (err) {
                        console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
                    }
                }
            }
        }
        this.forwardToAgent(line, agentStdout);
    }
    async executeCompensatingCall(toolName, args) {
        return new Promise((resolve) => {
            const callId = `proxy_compensate_${nanoid()}`;
            this.pendingCompensations.set(callId, (res) => resolve(res));
            const request = {
                jsonrpc: '2.0',
                id: callId,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: args
                }
            };
            this.forwardToUpstream(JSON.stringify(request));
        });
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
        if (!this.dbManager || !this.sessionId || !this.undoController) {
            error = {
                code: -32603,
                message: 'DatabaseManager, Session ID, or UndoController is not configured on the proxy.'
            };
        }
        else {
            try {
                if (toolName === 'undomcp_interactive') {
                    const text = handleInteractive(this.dbManager, this.sessionId);
                    result = { content: [{ type: 'text', text }] };
                }
                else if (toolName === 'undomcp_list_turns') {
                    const limit = args.limit !== undefined ? Number(args.limit) : 20;
                    const list = handleListTurns(this.dbManager, this.sessionId, limit);
                    result = { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
                }
                else if (toolName === 'undomcp_preview_undo') {
                    const actionIds = args.actionIds || [];
                    const turnIds = args.turnIds || [];
                    const previews = await handlePreviewUndo(this.dbManager, this.undoController, this.sessionId, actionIds, turnIds);
                    result = { content: [{ type: 'text', text: JSON.stringify(previews, null, 2) }] };
                }
                else if (toolName === 'undomcp_undo_selection') {
                    const actionIds = args.actionIds || [];
                    const turnIds = args.turnIds || [];
                    const confirmClassD = !!args.confirmClassD;
                    const overwriteConflicts = !!args.overwriteConflicts;
                    const undoResults = await handleUndoSelection(this.dbManager, this.undoController, this.sessionId, actionIds, turnIds, confirmClassD, overwriteConflicts);
                    const finalResults = [];
                    for (const undoResult of undoResults) {
                        if (undoResult.outcome === 'mcp_payload_ready' && undoResult.mcpPayload) {
                            try {
                                const compensationResponse = await this.executeCompensatingCall(undoResult.mcpPayload.params.name, undoResult.mcpPayload.params.arguments);
                                const isError = compensationResponse.error !== undefined || (compensationResponse.result && compensationResponse.result.isError === true);
                                if (isError) {
                                    this.dbManager.updateActionState(undoResult.actionId, 'undo_failed', new Date().toISOString(), undefined, JSON.stringify(compensationResponse.error || compensationResponse.result));
                                    finalResults.push({
                                        actionId: undoResult.actionId,
                                        success: false,
                                        outcome: 'error',
                                        error: `Compensating tool call failed: ${JSON.stringify(compensationResponse.error || compensationResponse.result)}`
                                    });
                                }
                                else {
                                    this.dbManager.updateActionState(undoResult.actionId, 'undone', new Date().toISOString(), compensationResponse.result);
                                    finalResults.push({
                                        actionId: undoResult.actionId,
                                        success: true,
                                        outcome: 'mcp_payload_ready'
                                    });
                                }
                            }
                            catch (err) {
                                this.dbManager.updateActionState(undoResult.actionId, 'undo_failed', new Date().toISOString(), undefined, err.message);
                                finalResults.push({
                                    actionId: undoResult.actionId,
                                    success: false,
                                    outcome: 'error',
                                    error: `Failed to execute compensating call: ${err.message}`
                                });
                            }
                        }
                        else {
                            finalResults.push(undoResult);
                        }
                    }
                    result = { content: [{ type: 'text', text: JSON.stringify(finalResults, null, 2) }] };
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
    forwardToUpstream(line) {
        if (this.childProcess && this.childProcess.stdin && !this.childProcess.stdin.destroyed) {
            this.childProcess.stdin.write(line + '\n');
        }
    }
    forwardToAgent(line, agentStdout) {
        if (!agentStdout.destroyed) {
            agentStdout.write(line + '\n');
        }
    }
}
