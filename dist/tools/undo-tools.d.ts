import { DatabaseManager } from '../journal/database-manager.js';
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
            prompt_text?: undefined;
        };
        required?: undefined;
    };
})[];
export declare function handleListHistory(dbManager: DatabaseManager, workingDirectory: string, limit?: number): any[];
