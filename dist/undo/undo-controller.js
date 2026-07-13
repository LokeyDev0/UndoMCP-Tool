/**
 * UndoController — Orchestrates the undo pipeline:
 *   1. File actions (Class A): Restore from snapshot with conflict detection
 *   2. MCP actions: Mark as undone in the journal (AI agent handles inverse calls)
 *
 * MCP inverse calls are NOT handled here. The AI agent reasons about and
 * executes inverse MCP calls directly, then uses this controller (via the
 * undomcp_undo_action tool) to mark actions as undone.
 */
import * as fs from 'fs';
import * as path from 'path';
import { verifyFileHash } from '../file-safety/conflict-detector.js';
export class UndoController {
    dbManager;
    snapshotStore;
    schemaCache;
    inverseResolver;
    llmSolver;
    constructor(dbManager, snapshotStore, schemaCache, inverseResolver, llmSolver) {
        this.dbManager = dbManager;
        this.snapshotStore = snapshotStore;
        this.schemaCache = schemaCache;
        this.inverseResolver = inverseResolver;
        this.llmSolver = llmSolver;
    }
    /**
     * Generates a preview of what would happen if the given actions were undone.
     * Does not modify any state.
     */
    async preview(actionIds) {
        const previews = [];
        // Load and sort actions in reverse sequence order
        const actions = this.loadAndSortActions(actionIds);
        for (const action of actions) {
            if (action.state === 'undone') {
                previews.push({
                    actionId: action.id,
                    toolName: action.toolName,
                    resolution: null,
                    alreadyUndone: true,
                    requiresConfirmation: false,
                    label: action.metadata?.label,
                });
                continue;
            }
            let resolution = this.inverseResolver.resolve(action);
            // Fall back to LLM solver if heuristics fail
            if (!resolution && this.llmSolver) {
                resolution = await this.llmSolver.solve(action, this.schemaCache);
            }
            previews.push({
                actionId: action.id,
                toolName: action.toolName,
                resolution,
                alreadyUndone: false,
                requiresConfirmation: resolution?.reversibilityClass === 'D',
                label: action.metadata?.label,
            });
        }
        return previews;
    }
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
    async execute(actionIds, conflictResolver) {
        const results = [];
        const actions = this.loadAndSortActions(actionIds);
        for (const action of actions) {
            // Skip already-undone actions
            if (action.state === 'undone') {
                results.push({
                    actionId: action.id,
                    success: true,
                    outcome: 'skipped',
                });
                continue;
            }
            try {
                // File actions: resolve and restore from snapshot
                if (action.actionType === 'file_change') {
                    const resolution = this.inverseResolver.resolve(action);
                    if (resolution && resolution.reversibilityClass === 'A' && resolution.inverseTool === '__file_restore__') {
                        const result = await this.executeFileAction(action, resolution, conflictResolver);
                        results.push(result);
                        continue;
                    }
                    if (resolution && resolution.reversibilityClass === 'A' && resolution.inverseTool === '__file_delete__') {
                        const result = await this.executeFileDeleteAction(action, resolution, conflictResolver);
                        results.push(result);
                        continue;
                    }
                }
                // MCP actions (and file actions without resolution): just mark as undone
                this.dbManager.updateActionState(action.id, 'undone', new Date().toISOString());
                results.push({
                    actionId: action.id,
                    success: true,
                    outcome: 'marked_undone',
                });
            }
            catch (err) {
                this.dbManager.updateActionState(action.id, 'undo_failed', new Date().toISOString(), undefined, err.message);
                results.push({
                    actionId: action.id,
                    success: false,
                    outcome: 'error',
                    error: err.message,
                });
            }
        }
        return results;
    }
    /**
     * Decompresses a snapshot and writes it back to disk.
     * Returns true on success, false on failure.
     */
    executeFileRestore(snapshotId, filePath) {
        try {
            const content = this.snapshotStore.getSnapshotContent(snapshotId);
            if (!content) {
                console.error(`[undomcp] Snapshot ${snapshotId} not found or empty.`);
                return false;
            }
            const absolutePath = path.resolve(filePath);
            // Ensure parent directory exists
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(absolutePath, content);
            return true;
        }
        catch (err) {
            console.error(`[undomcp] File restore failed for ${filePath}: ${err.message}`);
            return false;
        }
    }
    // --- Private helpers ---
    /**
     * Loads actions by ID and sorts them in reverse sequence order (last action first).
     */
    loadAndSortActions(actionIds) {
        const actions = [];
        for (const id of actionIds) {
            const action = this.dbManager.getAction(id);
            if (action) {
                actions.push(action);
            }
        }
        // Reverse sequence order for correct undo ordering
        actions.sort((a, b) => b.sequenceNum - a.sequenceNum);
        return actions;
    }
    /**
     * Handles file restore with conflict detection.
     */
    async executeFileAction(action, resolution, conflictResolver) {
        const filePath = resolution.inverseParams.filePath;
        const snapshotId = resolution.inverseParams.snapshotId;
        // Conflict detection: check if the file has been modified externally
        if (action.postHash) {
            const hashMatches = verifyFileHash(filePath, action.postHash);
            if (!hashMatches) {
                // File was modified externally after logging
                if (conflictResolver) {
                    const decision = await conflictResolver(filePath);
                    if (decision === 'exit') {
                        return {
                            actionId: action.id,
                            success: true,
                            outcome: 'skipped',
                        };
                    }
                    // User chose 'overwrite' — proceed with restore
                }
                else {
                    // No conflict resolver provided — skip
                    return {
                        actionId: action.id,
                        success: false,
                        outcome: 'error',
                        error: `File conflict detected for ${filePath}. File was modified externally.`,
                    };
                }
            }
        }
        // Perform the restore
        const restored = this.executeFileRestore(snapshotId, filePath);
        if (restored) {
            this.dbManager.updateActionState(action.id, 'undone', new Date().toISOString(), { restoredFromSnapshot: snapshotId });
            return {
                actionId: action.id,
                success: true,
                outcome: 'file_restored',
            };
        }
        this.dbManager.updateActionState(action.id, 'undo_failed', new Date().toISOString(), undefined, `Failed to restore file from snapshot ${snapshotId}`);
        return {
            actionId: action.id,
            success: false,
            outcome: 'error',
            error: `Failed to restore file from snapshot ${snapshotId}`,
        };
    }
    /**
     * Handles file delete (undoing a create) with conflict detection.
     */
    async executeFileDeleteAction(action, resolution, conflictResolver) {
        const filePath = resolution.inverseParams.filePath;
        const absolutePath = path.resolve(filePath);
        // If file does not exist, consider it already deleted (successful undo)
        if (!fs.existsSync(absolutePath)) {
            this.dbManager.updateActionState(action.id, 'undone', new Date().toISOString(), { deletedFilePath: filePath });
            return {
                actionId: action.id,
                success: true,
                outcome: 'file_restored',
            };
        }
        // Conflict detection: check if the file has been modified externally
        if (action.postHash) {
            const hashMatches = verifyFileHash(absolutePath, action.postHash);
            if (!hashMatches) {
                // File was modified externally after logging
                if (conflictResolver) {
                    const decision = await conflictResolver(filePath);
                    if (decision === 'exit') {
                        return {
                            actionId: action.id,
                            success: true,
                            outcome: 'skipped',
                        };
                    }
                    // User chose 'overwrite' — proceed with delete
                }
                else {
                    // No conflict resolver provided — skip
                    return {
                        actionId: action.id,
                        success: false,
                        outcome: 'error',
                        error: `File conflict detected for ${filePath}. File was modified externally.`,
                    };
                }
            }
        }
        try {
            fs.unlinkSync(absolutePath);
            this.dbManager.updateActionState(action.id, 'undone', new Date().toISOString(), { deletedFilePath: filePath });
            return {
                actionId: action.id,
                success: true,
                outcome: 'file_restored',
            };
        }
        catch (err) {
            this.dbManager.updateActionState(action.id, 'undo_failed', new Date().toISOString(), undefined, `Failed to delete file: ${err.message}`);
            return {
                actionId: action.id,
                success: false,
                outcome: 'error',
                error: `Failed to delete file: ${err.message}`,
            };
        }
    }
}
