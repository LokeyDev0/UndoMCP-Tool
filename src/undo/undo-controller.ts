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

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager, Action } from '../journal/database-manager.js';
import { SnapshotStore } from '../file-safety/snapshot-store.js';
import { SchemaCache } from './schema-cache.js';
import { InverseResolver, InverseResolution } from './inverse-resolver.js';
import { LlmSolver } from './llm-solver.js';
import { verifyFileHash } from '../file-safety/conflict-detector.js';

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
    params: { name: string; arguments: Record<string, any> };
  };
  /** Error message if outcome is 'error'. */
  error?: string;
  /** Whether a conflict was detected and the user chose to overwrite. */
  conflictOverwritten?: boolean;
}

export class UndoController {
  private dbManager: DatabaseManager;
  private snapshotStore: SnapshotStore;
  private schemaCache: SchemaCache;
  private inverseResolver: InverseResolver;
  private llmSolver?: LlmSolver;

  constructor(
    dbManager: DatabaseManager,
    snapshotStore: SnapshotStore,
    schemaCache: SchemaCache,
    inverseResolver: InverseResolver,
    llmSolver?: LlmSolver
  ) {
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
  public async preview(actionIds: string[]): Promise<UndoPreview[]> {
    const previews: UndoPreview[] = [];

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
   * - MCP actions (Class B/C): Returns the compensating payload (caller dispatches).
   * - LLM suggestions (Class D): Returns requires_confirmation, never auto-executes.
   *
   * @param conflictResolver Optional callback to resolve file conflicts.
   *   If not provided, conflicts cause the action to be skipped.
   */
  public async execute(
    actionIds: string[],
    conflictResolver?: (filePath: string) => Promise<'exit' | 'overwrite'>
  ): Promise<UndoResult[]> {
    const results: UndoResult[] = [];
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
        let resolution = this.inverseResolver.resolve(action);

        // Fall back to LLM solver
        if (!resolution && this.llmSolver) {
          resolution = await this.llmSolver.solve(action, this.schemaCache);
        }

        if (!resolution) {
          results.push({
            actionId: action.id,
            success: false,
            outcome: 'error',
            error: 'No inverse resolution found for this action.',
          });
          continue;
        }

        // Class D: suggestion only, never auto-execute
        if (resolution.reversibilityClass === 'D') {
          results.push({
            actionId: action.id,
            success: true,
            outcome: 'requires_confirmation',
            mcpPayload: {
              method: 'tools/call',
              params: {
                name: resolution.inverseTool,
                arguments: resolution.inverseParams,
              },
            },
          });
          continue;
        }

        // Class A: file restore
        if (resolution.reversibilityClass === 'A' && resolution.inverseTool === '__file_restore__') {
          const result = await this.executeFileAction(action, resolution, conflictResolver);
          results.push(result);
          continue;
        }

        if (resolution.reversibilityClass === 'A' && resolution.inverseTool === '__file_delete__') {
          const result = await this.executeFileDeleteAction(action, resolution, conflictResolver);
          results.push(result);
          continue;
        }

        // Class B/C: MCP compensating call
        this.dbManager.updateActionState(
          action.id,
          'undone',
          new Date().toISOString(),
          { inverseTool: resolution.inverseTool, inverseParams: resolution.inverseParams }
        );

        results.push({
          actionId: action.id,
          success: true,
          outcome: 'mcp_payload_ready',
          mcpPayload: {
            method: 'tools/call',
            params: {
              name: resolution.inverseTool,
              arguments: resolution.inverseParams,
            },
          },
        });
      } catch (err: any) {
        this.dbManager.updateActionState(
          action.id,
          'undo_failed',
          new Date().toISOString(),
          undefined,
          err.message
        );

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
  public executeFileRestore(snapshotId: string, filePath: string): boolean {
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
    } catch (err: any) {
      console.error(`[undomcp] File restore failed for ${filePath}: ${err.message}`);
      return false;
    }
  }

  // --- Private helpers ---

  /**
   * Loads actions by ID and sorts them in reverse sequence order (last action first).
   */
  private loadAndSortActions(actionIds: string[]): Action[] {
    const actions: Action[] = [];

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
  private async executeFileAction(
    action: Action,
    resolution: InverseResolution,
    conflictResolver?: (filePath: string) => Promise<'exit' | 'overwrite'>
  ): Promise<UndoResult> {
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
        } else {
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
      this.dbManager.updateActionState(
        action.id,
        'undone',
        new Date().toISOString(),
        { restoredFromSnapshot: snapshotId }
      );

      return {
        actionId: action.id,
        success: true,
        outcome: 'file_restored',
        conflictOverwritten: action.postHash ? !verifyFileHash(filePath, action.postHash) : undefined,
      };
    }

    this.dbManager.updateActionState(
      action.id,
      'undo_failed',
      new Date().toISOString(),
      undefined,
      `Failed to restore file from snapshot ${snapshotId}`
    );

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
  private async executeFileDeleteAction(
    action: Action,
    resolution: InverseResolution,
    conflictResolver?: (filePath: string) => Promise<'exit' | 'overwrite'>
  ): Promise<UndoResult> {
    const filePath = resolution.inverseParams.filePath;
    const absolutePath = path.resolve(filePath);

    // If file does not exist, consider it already deleted (successful undo)
    if (!fs.existsSync(absolutePath)) {
      this.dbManager.updateActionState(
        action.id,
        'undone',
        new Date().toISOString(),
        { deletedFilePath: filePath }
      );

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
        } else {
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

      this.dbManager.updateActionState(
        action.id,
        'undone',
        new Date().toISOString(),
        { deletedFilePath: filePath }
      );

      return {
        actionId: action.id,
        success: true,
        outcome: 'file_restored',
        conflictOverwritten: action.postHash ? !verifyFileHash(absolutePath, action.postHash) : undefined,
      };
    } catch (err: any) {
      this.dbManager.updateActionState(
        action.id,
        'undo_failed',
        new Date().toISOString(),
        undefined,
        `Failed to delete file: ${err.message}`
      );

      return {
        actionId: action.id,
        success: false,
        outcome: 'error',
        error: `Failed to delete file: ${err.message}`,
      };
    }
  }
}
