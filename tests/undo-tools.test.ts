import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseManager, Action } from '../src/journal/database-manager.js';
import { UNDO_TOOLS, handleListHistory } from '../src/tools/undo-tools.js';

describe('Undo Tools', () => {
  let tempDir: string;
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  const sessionId = 'tools_test_sess_1';
  const turnId1 = 'tools_test_turn_1';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undomcp-tools-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    dbManager = new DatabaseManager(tempDbPath);

    // Create session and turns
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: tempDir,
    });
    dbManager.createTurn({
      id: turnId1,
      sessionId,
      turnNum: 1,
      promptText: 'First prompt',
      timestamp: new Date().toISOString(),
      actionCount: 0,
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

    if (overrides.resultData !== undefined || overrides.resultSuccess !== undefined) {
      dbManager.updateActionResults(
        action.id,
        overrides.resultSuccess !== undefined ? !!overrides.resultSuccess : true,
        overrides.resultData
      );
    }
    return action;
  }

  describe('UNDO_TOOLS', () => {
    it('should define exactly 3 tools', () => {
      expect(UNDO_TOOLS).toHaveLength(3);
    });

    it('should contain undomcp_mark_turn', () => {
      const tool = UNDO_TOOLS.find(t => t.name === 'undomcp_mark_turn');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain('prompt_text');
    });

    it('should contain undomcp_list_history', () => {
      const tool = UNDO_TOOLS.find(t => t.name === 'undomcp_list_history');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty('limit');
    });

    it('should contain undomcp_undo_action', () => {
      const tool = UNDO_TOOLS.find(t => t.name === 'undomcp_undo_action');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain('action_ids');
    });
  });

  describe('handleListHistory', () => {
    it('should return empty array when no actions exist', () => {
      const result = handleListHistory(dbManager, tempDir, 10);
      expect(result).toEqual([]);
    });

    it('should return actions for the project', () => {
      createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_item',
        parameters: { id: 'item1' },
        resultData: { id: 'item1' },
        resultSuccess: 1 as any,
      });

      const result = handleListHistory(dbManager, tempDir, 10);
      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe('create_item');
      expect(result[0].success).toBe(true);
    });

    it('should respect the limit parameter', () => {
      for (let i = 1; i <= 5; i++) {
        createTestAction({
          turnId: turnId1,
          sequenceNum: i,
          toolName: `tool_${i}`,
          parameters: {},
          resultSuccess: 1 as any,
        });
      }

      const result = handleListHistory(dbManager, tempDir, 3);
      expect(result).toHaveLength(3);
    });

    it('should include depends_on array (initially empty for unrelated actions)', () => {
      createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'tool_a',
        parameters: { foo: 'bar' },
        resultSuccess: 1 as any,
      });

      const result = handleListHistory(dbManager, tempDir, 10);
      expect(result[0]).toHaveProperty('depends_on');
      expect(result[0].depends_on).toEqual([]);
    });
  });

  describe('Dependency Detection', () => {
    it('should detect high-confidence dependency when result ID is consumed as parameter', () => {
      // Action 1 produces an ID
      const act1 = createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'create_project',
        parameters: { name: 'test' },
        resultData: { id: 'proj_abc123def456' },
        resultSuccess: 1 as any,
      });

      // Action 2 consumes that ID
      const act2 = createTestAction({
        turnId: turnId1,
        sequenceNum: 2,
        toolName: 'add_member',
        parameters: { project_id: 'proj_abc123def456', user: 'alice' },
        resultSuccess: 1 as any,
      });

      const result = handleListHistory(dbManager, tempDir, 10);
      // Find the add_member entry — it should depend on create_project
      const addMember = result.find(r => r.toolName === 'add_member');
      expect(addMember).toBeDefined();
      expect(addMember!.depends_on.length).toBeGreaterThanOrEqual(1);
      expect(addMember!.depends_on[0].action_id).toBe(act1.id);
      expect(addMember!.depends_on[0].shared_values).toContain('proj_abc123def456');
      expect(addMember!.depends_on[0].confidence).toBe('high');
    });

    it('should detect medium-confidence dependency for same-resource operations', () => {
      // Two actions on the same resource
      const act1 = createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'update_project',
        parameters: { id: 'proj_abc123def456', title: 'v1' },
        resultSuccess: 1 as any,
      });

      const act2 = createTestAction({
        turnId: turnId1,
        sequenceNum: 2,
        toolName: 'update_project',
        parameters: { id: 'proj_abc123def456', title: 'v2' },
        resultSuccess: 1 as any,
      });

      const result = handleListHistory(dbManager, tempDir, 10);
      const secondUpdate = result.find(r => r.id === act2.id);
      expect(secondUpdate).toBeDefined();
      // Should have at least a medium-confidence dependency
      const dep = secondUpdate!.depends_on.find(d => d.action_id === act1.id);
      expect(dep).toBeDefined();
    });

    it('should not create false dependencies for non-identifier strings', () => {
      createTestAction({
        turnId: turnId1,
        sequenceNum: 1,
        toolName: 'tool_a',
        parameters: { name: 'test' },
        resultData: { status: 'ok', value: 'true' },
        resultSuccess: 1 as any,
      });

      createTestAction({
        turnId: turnId1,
        sequenceNum: 2,
        toolName: 'tool_b',
        parameters: { name: 'test', check: 'true' },
        resultSuccess: 1 as any,
      });

      const result = handleListHistory(dbManager, tempDir, 10);
      const toolB = result.find(r => r.toolName === 'tool_b');
      // 'true', 'ok', 'test' are too short/common to be IDs — no high-confidence deps
      const highDeps = toolB!.depends_on.filter(d => d.confidence === 'high');
      expect(highDeps).toHaveLength(0);
    });
  });
});
