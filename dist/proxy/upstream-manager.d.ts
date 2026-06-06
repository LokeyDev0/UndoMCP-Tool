import { ChildProcess } from 'child_process';
import * as readline from 'readline';
import { Writable } from 'stream';
export interface UpstreamDefinition {
    command: string;
    args: string[];
    env?: Record<string, string>;
    transport?: 'stdio';
}
export interface UpstreamInstance {
    namespace: string;
    definition: UpstreamDefinition;
    process: ChildProcess;
    reader: readline.Interface;
    pendingRequests: Map<string | number, (response: any) => void>;
}
export declare class UpstreamManager {
    private upstreams;
    private defaultNamespace;
    private isStopping;
    onMessage?: (namespace: string, parsedMessage: any) => void;
    constructor(configPath?: string, fallbackSingleUpstream?: {
        command: string;
        args: string[];
    });
    /**
     * Loads configurations from yaml or falls back to single-upstream options.
     */
    private loadConfig;
    private addUpstream;
    /**
     * Spawns all child processes.
     */
    start(agentStderr?: Writable): void;
    /**
     * Terminates all child processes.
     */
    stop(): void;
    /**
     * Lists tools from all upstreams, applying namespacing where appropriate.
     */
    listAllTools(): Promise<any[]>;
    /**
     * Send a JSON-RPC request to a specific upstream by namespace.
     */
    callUpstreamDirect(namespace: string, method: string, params: any, customId?: string | number): Promise<any>;
    /**
     * Routes a Namespaced tool call to the correct upstream process.
     */
    routeCall(toolName: string, args: any, customId?: string | number): Promise<any>;
    getUpstreamInstance(namespace: string): UpstreamInstance | undefined;
    getNamespaces(): string[];
    isMultiUpstream(): boolean;
    /**
     * Broadcasts a JSON-RPC request to all running upstream servers.
     * If the method is 'initialize', merges the capabilities and server details.
     */
    broadcast(method: string, params: any, customId?: string | number): Promise<any>;
}
