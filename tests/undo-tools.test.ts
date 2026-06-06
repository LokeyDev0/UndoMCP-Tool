import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseManager, Action } from '../src/journal/database-manager.js';
import { SnapshotStore } from '../src/file-safety/snapshot-store.js';
import { SchemaCache } from '../src/undo/schema-cache.js';
import { InverseResolver } from '../src/undo/inverse-resolver.js';
import { UndoController } from '../src/undo/undo-controller.js';
import {
  handleInteractive,
  handleListTurns,
  handlePreviewUndo,
  handleUndoSelection
} from '../src/tools/undo-tools.js';

describe('Undo Tools Handlers', () => {
  let tempDir: string;
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  let snapshotStore: SnapshotStore;
  let schemaCache: SchemaCache;
  let inverseResolver: InverseResolver;
  let undoController: UndoController;
  const sessionId = 'tools_test_sess_1';
  const turnId1 = 'tools_test_turn_1';
  const turnId2 = 'tools_test_turn_2';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undomcp-tools-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    dbManager = new DatabaseManager(tempDbPath);
    snapshotStore = new SnapshotStore(dbManager);
    schemaCache = new SchemaCache();
    inverseResolver = new InverseResolver(schemaCache);
    undoController = new UndoController(dbManager, snapshotStore, schemaCache, inverseResolver);

    // Create session and turns
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
    });
    dbManager.createTurn({
      id: turnId1,
      sessionId,
      turnNum: 1,
      promptText: 'First prompt',
      timestamp: new Date().toISOString(),
      actionCount: 0,
    });
    dbManager.createTurn({
      id: turnId2,
      sessionId,
      turnNum: 2,
      promptText: 'Second prompt',
      timestamp: new Date().toISOString(),
      actionCount: 0,
    });

    // Cache tools schemas
    schemaCache.updateFromToolsList({
      tools: [
        {
          name: 'create_item',
          description: 'Creates item',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id']
          }
        },
        {
          name: 'delete_item',
          description: 'Deletes item',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id']
          }
        }
      ]
    });
  });

  afterEach(() => {
    dbManager.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  function createTestAction(overrides: Partial<Action>): Action {
    const action: Action = {
      id: `act_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      sessionId,
      sequenceNum: 1,
      timestamp: new Date().toISOString(),
      actionType: 'mcp_call',
      state: 'executed',
      ...overrides,
    };
    dbManager.createAction(action);

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

  describe('handleInteractive', () => {
    it('should generate a markdown checklist from logged turns and actions', () => {
      createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { id: 'item1' },
        resultData: { id: 'item1' },
        metadata: { label: 'Create item item1' }
      });

      const output = handleInteractive(dbManager, sessionId);
      expect(output).toContain('### Recent turns and changes:');
      expect(output).toContain('**Turn #1**: "First prompt"');
      expect(output).toContain('[ ] Create item item1');
    });

    it('should return empty message when no turns exist', () => {
      // Clear turns from DB (not easily possible with current dbManager APIs unless we create a clean session without turns)
      const cleanSessionId = 'empty_sess_1';
      dbManager.createSession({ id: cleanSessionId, startedAt: new Date().toISOString() });
      const output = handleInteractive(dbManager, cleanSessionId);
      expect(output).toContain('No turns logged');
    });
  });

  describe('handleListTurns', () => {
    it('should return formatted list of turns and their actions', () => {
      createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { id: 'item1' },
        resultData: { id: 'item1' },
        metadata: { label: 'Create item item1' }
      });

      const list = handleListTurns(dbManager, sessionId);
      expect(list.length).toBe(2); // turn 1 and turn 2
      // Check turn 1 properties
      const turn1Obj = list.find(t => t.id === turnId1);
      expect(turn1Obj).toBeDefined();
      expect(turn1Obj?.promptText).toBe('First prompt');
      expect(turn1Obj?.actions.length).toBe(1);
      expect(turn1Obj?.actions[0].toolName).toBe('create_item');
      expect(turn1Obj?.actions[0].label).toBe('Create item item1');
    });
  });

  describe('handlePreviewUndo', () => {
    it('should generate previews for selected actions and turns', async () => {
      const act1 = createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { id: 'item1' },
        resultData: { id: 'item1' },
      });

      const previews = await handlePreviewUndo(dbManager, undoController, sessionId, [act1.id]);
      expect(previews.length).toBe(1);
      expect(previews[0].actionId).toBe(act1.id);
      expect(previews[0].resolution?.inverseTool).toBe('delete_item');
    });

    it('should resolve actions from turn IDs in preview', async () => {
      const act1 = createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { id: 'item1' },
        resultData: { id: 'item1' },
      });

      const previews = await handlePreviewUndo(dbManager, undoController, sessionId, [], [turnId1]);
      expect(previews.length).toBe(1);
      expect(previews[0].actionId).toBe(act1.id);
    });
  });

  describe('handleUndoSelection', () => {
    it('should execute undo for selected action IDs', async () => {
      const act1 = createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { id: 'item1' },
        resultData: { id: 'item1' },
      });

      const results = await handleUndoSelection(dbManager, undoController, sessionId, [act1.id]);
      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(results[0].outcome).toBe('mcp_payload_ready');
      expect(results[0].mcpPayload?.params.name).toBe('delete_item');
      expect(results[0].mcpPayload?.params.arguments.id).toBe('item1');
    });

    it('should override Class D confirmation when confirmClassD is true', async () => {
      // Mock an unknown action which resolves to Class D (or has no direct heuristic, but LLM solver isn't present, so it fails heuristic. Let's create an action that resolves to Class D. Wait, how to make it Class D?
      // Ah! We can manually insert a resolved Class D action into the DB but with status 'executed', wait, resolution is computed dynamically using inverseResolver.resolve().
      // How does inverseResolver resolve Class D?
      // It doesn't! The LLM solver returns Class D.
      // So let's mock LlmSolver to return a Class D suggestion.
      const { LlmSolver } = await import('../src/undo/llm-solver.js');
      const mockLlmSolver = new LlmSolver({ enabled: true, endpoint: 'http://localhost' });
      // Stub the solve method
      mockLlmSolver.solve = async () => ({
        inverseTool: 'delete_item',
        inverseParams: { id: 'item99' },
        source: 'llm_suggestion',
        confidence: 0.3,
        reversibilityClass: 'D'
      });

      const controllerWithLlm = new UndoController(dbManager, snapshotStore, schemaCache, inverseResolver, mockLlmSolver);

      const act1 = createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'unknown_tool',
        parameters: { id: 'item1' },
      });

      // Without confirmClassD: should return requires_confirmation
      const res1 = await handleUndoSelection(dbManager, controllerWithLlm, sessionId, [act1.id], [], false);
      expect(res1[0].outcome).toBe('requires_confirmation');

      // Reset action state to executed
      dbManager.updateActionState(act1.id, 'executed');

      // With confirmClassD: should bypass and return mcp_payload_ready
      const res2 = await handleUndoSelection(dbManager, controllerWithLlm, sessionId, [act1.id], [], true);
      expect(res2[0].outcome).toBe('mcp_payload_ready');
      expect(res2[0].mcpPayload?.params.name).toBe('delete_item');
      expect(res2[0].mcpPayload?.params.arguments.id).toBe('item99');
      
      const dbAction = dbManager.getAction(act1.id);
      expect(dbAction?.state).toBe('undone');
    });
  });
});
