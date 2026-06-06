import { DatabaseManager } from '../journal/database-manager.js';
import { UndoController, UndoPreview, UndoResult } from '../undo/undo-controller.js';
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
            actionIds?: undefined;
            turnIds?: undefined;
            confirmClassD?: undefined;
            overwriteConflicts?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            prompt_text?: undefined;
            limit?: undefined;
            actionIds?: undefined;
            turnIds?: undefined;
            confirmClassD?: undefined;
            overwriteConflicts?: undefined;
        };
        required?: undefined;
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
            actionIds?: undefined;
            turnIds?: undefined;
            confirmClassD?: undefined;
            overwriteConflicts?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actionIds: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            turnIds: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            prompt_text?: undefined;
            limit?: undefined;
            confirmClassD?: undefined;
            overwriteConflicts?: undefined;
        };
        required?: undefined;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            actionIds: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            turnIds: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            confirmClassD: {
                type: string;
                default: boolean;
                description: string;
            };
            overwriteConflicts: {
                type: string;
                default: boolean;
                description: string;
            };
            prompt_text?: undefined;
            limit?: undefined;
        };
        required?: undefined;
    };
})[];
export interface FormattedTurn {
    id: string;
    turnNum: number;
    promptText?: string;
    timestamp: string;
    actions: {
        id: string;
        toolName?: string;
        label?: string;
        state: string;
        reversibilityClass?: string;
    }[];
}
export declare function handleInteractive(dbManager: DatabaseManager, sessionId: string): string;
export declare function handleListTurns(dbManager: DatabaseManager, sessionId: string, limit?: number): FormattedTurn[];
export declare function handlePreviewUndo(dbManager: DatabaseManager, undoController: UndoController, sessionId: string, actionIds?: string[], turnIds?: string[]): Promise<UndoPreview[]>;
export declare function handleUndoSelection(dbManager: DatabaseManager, undoController: UndoController, sessionId: string, actionIds?: string[], turnIds?: string[], confirmClassD?: boolean, overwriteConflicts?: boolean): Promise<UndoResult[]>;
