import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { UndoController, UndoPreview, UndoResult } from '../src/undo/undo-controller.js';
import { DatabaseManager, Action } from '../src/journal/database-manager.js';
import { SnapshotStore } from '../src/file-safety/snapshot-store.js';
import { SchemaCache } from '../src/undo/schema-cache.js';
import { InverseResolver } from '../src/undo/inverse-resolver.js';

describe('UndoController', () => {
  let tempDir: string;
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  let snapshotStore: SnapshotStore;
  let schemaCache: SchemaCache;
  let inverseResolver: InverseResolver;
  let controller: UndoController;
  const sessionId = 'undo_ctrl_sess_1';
  const turnId = 'undo_ctrl_turn_1';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undomcp-ctrl-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    dbManager = new DatabaseManager(tempDbPath);
    snapshotStore = new SnapshotStore(dbManager);
    schemaCache = new SchemaCache();
    inverseResolver = new InverseResolver(schemaCache);
    controller = new UndoController(dbManager, snapshotStore, schemaCache, inverseResolver);

    // Create test session and turn
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
    });
    dbManager.createTurn({
      id: turnId,
      sessionId,
      turnNum: 1,
      timestamp: new Date().toISOString(),
      actionCount: 0,
    });

    // Populate schema cache with test tools
    schemaCache.updateFromToolsList({
      tools: [
        {
          name: 'create_item',
          description: 'Creates an item',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        {
          name: 'delete_item',
          description: 'Deletes an item',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
        {
          name: 'update_setting',
          description: 'Updates a setting',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['key', 'value'],
          },
        },
      ],
    });
  });

  afterEach(() => {
    dbManager.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  });

  function createTestAction(overrides: Partial<Action>): Action {
    const action: Action = {
      id: `act_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      sessionId,
      turnId,
      sequenceNum: 1,
      timestamp: new Date().toISOString(),
      actionType: 'mcp_call',
      state: 'executed',
      ...overrides,
    };
    dbManager.createAction(action);

    // createAction doesn't write result_data, result_success, or post_hash.
    // Those columns are populated via updateActionResults, so we call it here
    // when test data includes resultData or postHash.
    if (action.resultData || action.postHash) {
      dbManager.updateActionResults(
        action.id,
        action.resultSuccess !== undefined ? !!action.resultSuccess : true,
        action.resultData,
        action.resultLatencyMs,
        action.postHash
      );
    }

    return action;
  }

  describe('preview', () => {
    it('should return correct inverse resolutions for an MCP action', async () => {
      const action = createTestAction({
        toolName: 'create_item',
        parameters: { name: 'Widget' },
        resultData: { id: 'item_1', name: 'Widget' },
      });

      const previews = await controller.preview([action.id]);

      expect(previews.length).toBe(1);
      expect(previews[0].actionId).toBe(action.id);
      expect(previews[0].alreadyUndone).toBe(false);
      expect(previews[0].requiresConfirmation).toBe(false);
      expect(previews[0].resolution).toBeTruthy();
      expect(previews[0].resolution!.inverseTool).toBe('delete_item');
      expect(previews[0].resolution!.inverseParams.id).toBe('item_1');
    });

    it('should flag already-undone actions', async () => {
      const action = createTestAction({
        toolName: 'create_item',
        parameters: { name: 'Widget' },
        resultData: { id: 'item_1' },
      });

      // Mark it as undone
      dbManager.updateActionState(action.id, 'undone', new Date().toISOString());

      const previews = await controller.preview([action.id]);

      expect(previews.length).toBe(1);
      expect(previews[0].alreadyUndone).toBe(true);
      expect(previews[0].resolution).toBeNull();
    });

    it('should return null resolution for unresolvable actions', async () => {
      const action = createTestAction({
        toolName: 'transform_data',
        parameters: { input: 'test' },
      });

      const previews = await controller.preview([action.id]);

      expect(previews.length).toBe(1);
      expect(previews[0].resolution).toBeNull();
    });

    it('should return previews for mixed action types', async () => {
      const action1 = createTestAction({
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { name: 'Item A' },
        resultData: { id: 'id_a' },
      });

      const action2 = createTestAction({
        sequenceNum: 2,
        toolName: 'unknown_verb_tool',
        parameters: { foo: 'bar' },
      });

      const previews = await controller.preview([action1.id, action2.id]);

      expect(previews.length).toBe(2);
      // Higher sequence num first (reverse order)
      expect(previews[0].actionId).toBe(action2.id);
      expect(previews[0].resolution).toBeNull();
      expect(previews[1].actionId).toBe(action1.id);
      expect(previews[1].resolution).toBeTruthy();
    });
  });

  describe('execute', () => {
    it('should prepare MCP payload for a Class B action and mark it undone', async () => {
      const action = createTestAction({
        toolName: 'create_item',
        parameters: { name: 'Widget' },
        resultData: { id: 'item_99' },
      });

      const results = await controller.execute([action.id]);

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].outcome).toBe('mcp_payload_ready');
      expect(results[0].mcpPayload).toBeTruthy();
      expect(results[0].mcpPayload!.method).toBe('tools/call');
      expect(results[0].mcpPayload!.params.name).toBe('delete_item');
      expect(results[0].mcpPayload!.params.arguments.id).toBe('item_99');

      // Verify DB state updated
      const updatedAction = dbManager.getAction(action.id);
      expect(updatedAction!.state).toBe('undone');
    });

    it('should skip already-undone actions', async () => {
      const action = createTestAction({
        toolName: 'create_item',
        parameters: { name: 'Widget' },
        resultData: { id: 'item_1' },
      });

      dbManager.updateActionState(action.id, 'undone', new Date().toISOString());

      const results = await controller.execute([action.id]);

      expect(results.length).toBe(1);
      expect(results[0].outcome).toBe('skipped');
    });

    it('should return error for unresolvable actions', async () => {
      const action = createTestAction({
        toolName: 'transform_data',
        parameters: { input: 'test' },
      });

      const results = await controller.execute([action.id]);

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      expect(results[0].outcome).toBe('error');
      expect(results[0].error).toContain('No inverse resolution found');
    });

    it('should execute actions in reverse sequence order', async () => {
      const action1 = createTestAction({
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { name: 'First' },
        resultData: { id: 'id_1' },
      });

      const action2 = createTestAction({
        sequenceNum: 2,
        toolName: 'create_item',
        parameters: { name: 'Second' },
        resultData: { id: 'id_2' },
      });

      const results = await controller.execute([action1.id, action2.id]);

      expect(results.length).toBe(2);
      // First result should be the last action (seq 2)
      expect(results[0].mcpPayload!.params.arguments.id).toBe('id_2');
      expect(results[1].mcpPayload!.params.arguments.id).toBe('id_1');
    });
  });

  describe('executeFileRestore', () => {
    it('should restore file content from a snapshot', () => {
      const filePath = path.join(tempDir, 'restore-test.txt');
      const originalContent = Buffer.from('Original content');

      // Create snapshot
      const snapshotId = snapshotStore.createSnapshot(undefined, filePath, originalContent, 'pre');

      // Write different content to the file
      fs.writeFileSync(filePath, 'Modified content');

      // Restore from snapshot
      const success = controller.executeFileRestore(snapshotId, filePath);

      expect(success).toBe(true);
      const restoredContent = fs.readFileSync(filePath, 'utf8');
      expect(restoredContent).toBe('Original content');
    });

    it('should create parent directories if they do not exist', () => {
      const nestedPath = path.join(tempDir, 'nested', 'deep', 'restore-test.txt');
      const content = Buffer.from('Nested content');

      const snapshotId = snapshotStore.createSnapshot(undefined, nestedPath, content, 'pre');

      const success = controller.executeFileRestore(snapshotId, nestedPath);

      expect(success).toBe(true);
      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(fs.readFileSync(nestedPath, 'utf8')).toBe('Nested content');
    });

    it('should return false for non-existent snapshot IDs', () => {
      const success = controller.executeFileRestore('snap_nonexistent', path.join(tempDir, 'test.txt'));
      expect(success).toBe(false);
    });
  });

  describe('execute with file_change actions', () => {
    it('should restore a file from snapshot and update action state', async () => {
      const filePath = path.join(tempDir, 'file-undo-test.txt');
      const originalContent = Buffer.from('Before change');

      // Create the pre-state snapshot
      const preSnapshotId = snapshotStore.createSnapshot(undefined, filePath, originalContent, 'pre');

      // Write the "changed" content and compute its hash
      const changedContent = Buffer.from('After change');
      fs.writeFileSync(filePath, changedContent);
      const { computeSha256 } = await import('../src/file-safety/snapshot-store.js');
      const postHash = computeSha256(changedContent);

      // Create the action
      const action = createTestAction({
        actionType: 'file_change',
        preSnapshotId,
        postHash,
        parameters: { filePath, operation: 'modify' },
      });

      const results = await controller.execute([action.id]);

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].outcome).toBe('file_restored');

      // Verify the file content was restored
      const restoredContent = fs.readFileSync(filePath, 'utf8');
      expect(restoredContent).toBe('Before change');

      // Verify DB state updated
      const updatedAction = dbManager.getAction(action.id);
      expect(updatedAction!.state).toBe('undone');
    });

    it('should detect conflict and skip when no conflictResolver is provided', async () => {
      const filePath = path.join(tempDir, 'conflict-test.txt');
      const originalContent = Buffer.from('Original');
      const preSnapshotId = snapshotStore.createSnapshot(undefined, filePath, originalContent, 'pre');

      // Write changed content and record its hash
      const changedContent = Buffer.from('Changed by agent');
      fs.writeFileSync(filePath, changedContent);
      const { computeSha256 } = await import('../src/file-safety/snapshot-store.js');
      const postHash = computeSha256(changedContent);

      // Now write DIFFERENT content to simulate an external modification
      fs.writeFileSync(filePath, 'External edit by user');

      const action = createTestAction({
        actionType: 'file_change',
        preSnapshotId,
        postHash,
        parameters: { filePath, operation: 'modify' },
      });

      const results = await controller.execute([action.id]);

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      expect(results[0].outcome).toBe('error');
      expect(results[0].error).toContain('conflict');
    });

    it('should resolve conflict with overwrite when conflictResolver returns overwrite', async () => {
      const filePath = path.join(tempDir, 'conflict-overwrite-test.txt');
      const originalContent = Buffer.from('Original content here');
      const preSnapshotId = snapshotStore.createSnapshot(undefined, filePath, originalContent, 'pre');

      const changedContent = Buffer.from('Agent changes');
      fs.writeFileSync(filePath, changedContent);
      const { computeSha256 } = await import('../src/file-safety/snapshot-store.js');
      const postHash = computeSha256(changedContent);

      // External modification
      fs.writeFileSync(filePath, 'User manual edit');

      const action = createTestAction({
        actionType: 'file_change',
        preSnapshotId,
        postHash,
        parameters: { filePath, operation: 'modify' },
      });

      const results = await controller.execute(
        [action.id],
        async () => 'overwrite'
      );

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].outcome).toBe('file_restored');

      // File should be restored to original
      const restoredContent = fs.readFileSync(filePath, 'utf8');
      expect(restoredContent).toBe('Original content here');
    });

    it('should skip when conflictResolver returns exit', async () => {
      const filePath = path.join(tempDir, 'conflict-exit-test.txt');
      const originalContent = Buffer.from('Original');
      const preSnapshotId = snapshotStore.createSnapshot(undefined, filePath, originalContent, 'pre');

      const changedContent = Buffer.from('Changed');
      fs.writeFileSync(filePath, changedContent);
      const { computeSha256 } = await import('../src/file-safety/snapshot-store.js');
      const postHash = computeSha256(changedContent);

      fs.writeFileSync(filePath, 'External edit');

      const action = createTestAction({
        actionType: 'file_change',
        preSnapshotId,
        postHash,
        parameters: { filePath, operation: 'modify' },
      });

      const results = await controller.execute(
        [action.id],
        async () => 'exit'
      );

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].outcome).toBe('skipped');

      // File should still have the external edit
      expect(fs.readFileSync(filePath, 'utf8')).toBe('External edit');
    });
  });
});
