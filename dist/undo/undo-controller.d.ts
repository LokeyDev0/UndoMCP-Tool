/**
 * UndoController — Orchestrates the full undo pipeline:
 *   1. Resolve inverses (heuristic → LLM fallback)
 *   2. Check for file conflicts
 *   3. Execute file restores
 *   4. Prepare MCP compensating call payloads
 *
 * MCP compensating calls are NOT dispatched here. The controller returns
 * the prepared payload for the caller (undo tool or TUI) to forward
 * through the proxy. This will be wired up in Phase 5 (Step 12).
 */
import { DatabaseManager } from '../journal/database-manager.js';
import { SnapshotStore } from '../file-safety/snapshot-store.js';
import { SchemaCache } from './schema-cache.js';
import { InverseResolver, InverseResolution } from './inverse-resolver.js';
import { LlmSolver } from './llm-solver.js';
export interface UndoPreview {
    actionId: string;
    toolName?: string;
    resolution: InverseResolution | null;
    /** True if the action has already been undone. */
    alreadyUndone: boolean;
    /** True if this is a Class D suggestion requiring user confirmation. */
    requiresConfirmation: boolean;
    /** Human-readable label from action metadata. */
    label?: string;
}
export interface UndoResult {
    actionId: string;
    success: boolean;
    /** 'file_restored' | 'mcp_payload_ready' | 'requires_confirmation' | 'skipped' | 'error' */
    outcome: 'file_restored' | 'mcp_payload_ready' | 'requires_confirmation' | 'skipped' | 'error';
    /** For MCP reversals, the compensating JSON-RPC request payload. */
    mcpPayload?: {
        method: string;
        params: {
            name: string;
            arguments: Record<string, any>;
        };
    };
    /** Error message if outcome is 'error'. */
    error?: string;
    /** Whether a conflict was detected and the user chose to overwrite. */
    conflictOverwritten?: boolean;
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
     * - MCP actions (Class B/C): Returns the compensating payload (caller dispatches).
     * - LLM suggestions (Class D): Returns requires_confirmation, never auto-executes.
     *
     * @param conflictResolver Optional callback to resolve file conflicts.
     *   If not provided, conflicts cause the action to be skipped.
     */
    execute(actionIds: string[], conflictResolver?: (filePath: string) => Promise<'exit' | 'overwrite'>): Promise<UndoResult[]>;
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
}
