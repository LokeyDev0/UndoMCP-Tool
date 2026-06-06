import { Readable, Writable } from 'stream';
import { DatabaseManager } from '../journal/database-manager.js';
import { SchemaCache } from '../undo/schema-cache.js';
export interface ProxyEngineOptions {
    command: string;
    args: string[];
    configPath?: string;
    env?: Record<string, string>;
    dbManager?: DatabaseManager;
    sessionId?: string;
    turnId?: string;
    turnIdleTimeoutMs?: number;
    onRequest?: (request: any) => Promise<void> | void;
    onResponse?: (request: any, response: any) => Promise<void> | void;
}
export declare class ProxyEngine {
    private command;
    private args;
    private env;
    private isStopping;
    private onRequestCallback?;
    private onResponseCallback?;
    private dbManager?;
    private sessionId?;
    private turnId?;
    private nextSequenceNum;
    private turnIdleTimeoutMs;
    private lastActionEndTime?;
    private schemaCache;
    private undoController;
    private pendingCompensations;
    private upstreamManager;
    private activeRequests;
    private agentReader;
    private fileWatcher?;
    private shadowStore?;
    watcherPromise: Promise<void> | null;
    constructor(options: ProxyEngineOptions);
    /**
     * Updates the active turn ID dynamically.
     */
    setTurnId(turnId: string | undefined): void;
    /**
     * Returns the schema cache, populated from upstream tools/list responses.
     */
    getSchemaCache(): SchemaCache;
    /**
     * Starts the proxy engine by spawning the upstream processes and connecting streams.
     */
    start(agentStdin?: Readable, agentStdout?: Writable, agentStderr?: Writable): void;
    /**
     * Stops the proxy engine and terminates the child processes.
     */
    stop(): void;
    private cleanup;
    private setupSignalHandlers;
    private handleMarkTurn;
    private handleAgentLine;
    private executeCompensatingCall;
    private handleUndoToolCall;
    private forwardToAgent;
    private ensureActiveTurnId;
}
