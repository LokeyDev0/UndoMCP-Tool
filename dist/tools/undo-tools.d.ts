/**
 * Undo Tools — Defines the MCP tools exposed by the UndoMCP proxy and their handlers.
 */
import { DatabaseManager } from '../journal/database-manager.js';
interface Dependency {
    action_id: string;
    shared_values: string[];
    confidence: 'high' | 'medium';
    reason?: string;
}
interface HistoryEntry {
    id: string;
    sessionId: string;
    timestamp: string;
    toolName?: string;
    namespace?: string;
    parameters?: Record<string, any>;
    success: boolean;
    resultData?: Record<string, any>;
    state: string;
    depends_on: Dependency[];
}
export declare const UNDO_TOOLS: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            prompt_text: {
                type: string;
                description: string;
            };
            limit?: undefined;
            namespace?: undefined;
            tool_name?: undefined;
            action_ids?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            limit: {
                type: string;
                default: number;
                description: string;
            };
            namespace: {
                type: string;
                description: string;
            };
            tool_name: {
                type: string;
                description: string;
            };
            prompt_text?: undefined;
            action_ids?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            action_ids: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            prompt_text?: undefined;
            limit?: undefined;
            namespace?: undefined;
            tool_name?: undefined;
        };
        required: string[];
    };
})[];
export declare function handleListHistory(dbManager: DatabaseManager, workingDirectory: string, limit?: number): HistoryEntry[];
export {};
