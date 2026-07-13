import { DatabaseManager } from '../journal/database-manager.js';
import { SnapshotStore } from '../file-safety/snapshot-store.js';
import { SchemaCache } from './schema-cache.js';
import { InverseResolver, InverseResolution } from './inverse-resolver.js';
import { LlmSolver } from './llm-solver.js';
export type ConflictResolver = (filePath: string) => Promise<'overwrite' | 'exit'>;
export interface UndoPreview {
    actionId: string;
    toolName?: string;
    resolution: InverseResolution | null;
    alreadyUndone: boolean;
    requiresConfirmation: boolean;
    label?: string;
}
export interface UndoResult {
    actionId: string;
    success: boolean;
    outcome: 'file_restored' | 'marked_undone' | 'skipped' | 'error';
    error?: string;
}
export declare class UndoController {
    private dbManager;
    private snapshotStore;
    private schemaCache;
    private inverseResolver;
    private llmSolver?;
    constructor(dbManager: DatabaseManager, snapshotStore: SnapshotStore, schemaCache: SchemaCache, inverseResolver: InverseResolver, llmSolver?: LlmSolver);
    /**
     * Generates a preview of what would happen if the given actions were undone.
     * Does not modify any state.
     */
    preview(actionIds: string[]): Promise<UndoPreview[]>;
    /**
     * Executes the undo pipeline for the given action IDs.
     *
     * - File actions (Class A): Restores file from snapshot, with conflict detection.
     * - MCP actions: Simply marks them as undone in the journal.
     *   The AI agent handles inverse MCP calls directly.
     *
     * @param conflictResolver Optional callback to resolve file conflicts.
     *   If not provided, conflicts cause the action to be skipped.
     */
    execute(actionIds: string[], conflictResolver?: ConflictResolver): Promise<UndoResult[]>;
    /**
     * Decompresses a snapshot and writes it back to disk.
     * Returns true on success, false on failure.
     */
    executeFileRestore(snapshotId: string, filePath: string): boolean;
    /**
     * Loads actions by ID and sorts them in reverse sequence order (last action first).
     */
    private loadAndSortActions;
    /**
     * Handles file restore with conflict detection.
     */
    private executeFileAction;
    /**
     * Handles file delete (undoing a create) with conflict detection.
     */
    private executeFileDeleteAction;
}
