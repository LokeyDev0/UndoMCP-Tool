import { describe, it, expect, beforeEach } from 'vitest';
import { InverseResolver, InverseResolution } from '../src/undo/inverse-resolver.js';
import { SchemaCache } from '../src/undo/schema-cache.js';
import { Action } from '../src/journal/database-manager.js';

function makeAction(overrides: Partial<Action>): Action {
  return {
    id: 'act_test_1',
    sessionId: 'sess_1',
    sequenceNum: 1,
    timestamp: new Date().toISOString(),
    actionType: 'mcp_call',
    state: 'executed',
    ...overrides,
  };
}

describe('InverseResolver', () => {
  let schemaCache: SchemaCache;
  let resolver: InverseResolver;

  beforeEach(() => {
    schemaCache = new SchemaCache();
    resolver = new InverseResolver(schemaCache);
  });

  describe('File-system shadow resolution (Class A)', () => {
    it('should resolve file_change actions with preSnapshotId as Class A', () => {
      const action = makeAction({
        actionType: 'file_change',
        preSnapshotId: 'snap_abc123',
        parameters: { filePath: '/workspace/test.txt', operation: 'modify' },
      });

      const result = resolver.resolve(action);

      expect(result).toBeTruthy();
      expect(result!.reversibilityClass).toBe('A');
      expect(result!.confidence).toBe(1.0);
      expect(result!.source).toBe('filesystem_shadow');
      expect(result!.inverseTool).toBe('__file_restore__');
      expect(result!.inverseParams.snapshotId).toBe('snap_abc123');
      expect(result!.inverseParams.filePath).toBe('/workspace/test.txt');
    });

    it('should return null for file_change without preSnapshotId', () => {
      const action = makeAction({
        actionType: 'file_change',
        parameters: { filePath: '/workspace/test.txt' },
      });

      expect(resolver.resolve(action)).toBeNull();
    });

    it('should resolve create file_change action to __file_delete__', () => {
      const action = makeAction({
        actionType: 'file_change',
        parameters: { filePath: '/workspace/test.txt', operation: 'create' },
        postHash: 'hash_abc123'
      });

      const result = resolver.resolve(action);

      expect(result).toBeTruthy();
      expect(result!.reversibilityClass).toBe('A');
      expect(result!.confidence).toBe(1.0);
      expect(result!.source).toBe('filesystem_shadow');
      expect(result!.inverseTool).toBe('__file_delete__');
      expect(result!.inverseParams.filePath).toBe('/workspace/test.txt');
      expect(result!.inverseParams.postHash).toBe('hash_abc123');
    });
  });

  describe('Verb-pair heuristic resolution (Class B)', () => {
    beforeEach(() => {
      // Set up a schema cache with create/delete pairs
      schemaCache.updateFromToolsList({
        tools: [
          {
            name: 'create_item',
            description: 'Creates an item',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string' }, category: { type: 'string' } },
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
            name: 'add_member',
            description: 'Adds a team member',
            inputSchema: {
              type: 'object',
              properties: { team_id: { type: 'string' }, user_id: { type: 'string' } },
              required: ['team_id', 'user_id'],
            },
          },
          {
            name: 'remove_member',
            description: 'Removes a team member',
            inputSchema: {
              type: 'object',
              properties: { team_id: { type: 'string' }, user_id: { type: 'string' } },
              required: ['team_id', 'user_id'],
            },
          },
          {
            name: 'enable_feature',
            description: 'Enables a feature flag',
            inputSchema: {
              type: 'object',
              properties: { feature_id: { type: 'string' } },
              required: ['feature_id'],
            },
          },
          {
            name: 'disable_feature',
            description: 'Disables a feature flag',
            inputSchema: {
              type: 'object',
              properties: { feature_id: { type: 'string' } },
              required: ['feature_id'],
            },
          },
        ],
      });
    });

    it('should resolve create_item → delete_item with id from resultData', () => {
      const action = makeAction({
        toolName: 'create_item',
        parameters: { name: 'Test Item', category: 'test' },
        resultData: { id: 'abc123', name: 'Test Item' },
      });

      const result = resolver.resolve(action);

      expect(result).toBeTruthy();
      expect(result!.reversibilityClass).toBe('B');
      expect(result!.inverseTool).toBe('delete_item');
      expect(result!.inverseParams.id).toBe('abc123');
      expect(result!.confidence).toBe(0.9);
      expect(result!.source).toBe('heuristic');
    });

    it('should resolve add_member → remove_member with parameter passthrough', () => {
      const action = makeAction({
        toolName: 'add_member',
        parameters: { team_id: 'team_1', user_id: 'user_42' },
        resultData: { success: true },
      });

      const result = resolver.resolve(action);

      expect(result).toBeTruthy();
      expect(result!.inverseTool).toBe('remove_member');
      expect(result!.inverseParams.team_id).toBe('team_1');
      expect(result!.inverseParams.user_id).toBe('user_42');
      expect(result!.reversibilityClass).toBe('B');
    });

    it('should resolve enable_feature → disable_feature', () => {
      const action = makeAction({
        toolName: 'enable_feature',
        parameters: { feature_id: 'dark_mode' },
        resultData: { enabled: true },
      });

      const result = resolver.resolve(action);

      expect(result).toBeTruthy();
      expect(result!.inverseTool).toBe('disable_feature');
      expect(result!.inverseParams.feature_id).toBe('dark_mode');
    });

    it('should return null when no matching inverse tool exists in cache', () => {
      const action = makeAction({
        toolName: 'create_widget',
        parameters: { name: 'Widget' },
        resultData: { id: 'w1' },
      });

      // There is no 'delete_widget' in the schema cache
      expect(resolver.resolve(action)).toBeNull();
    });

    it('should return null when required params cannot be mapped', () => {
      // delete_item requires 'id', but the result has no id field
      const action = makeAction({
        toolName: 'create_item',
        parameters: { name: 'Test' },
        resultData: { status: 'created' }, // no id field!
      });

      expect(resolver.resolve(action)).toBeNull();
    });
  });

  describe('Same-tool restore resolution (Class C)', () => {
    beforeEach(() => {
      schemaCache.updateFromToolsList({
        tools: [
          {
            name: 'update_config',
            description: 'Updates configuration',
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

    it('should resolve update_config → update_config with original params (Class C)', () => {
      const action = makeAction({
        toolName: 'update_config',
        parameters: { key: 'theme', value: 'dark' },
        resultData: { updated: true },
      });

      const result = resolver.resolve(action);

      expect(result).toBeTruthy();
      expect(result!.reversibilityClass).toBe('C');
      expect(result!.inverseTool).toBe('update_config');
      expect(result!.inverseParams.key).toBe('theme');
      expect(result!.inverseParams.value).toBe('dark');
      expect(result!.confidence).toBe(0.5);
    });

    it('should return null for update tools not in the schema cache', () => {
      const action = makeAction({
        toolName: 'update_settings',
        parameters: { mode: 'compact' },
      });

      expect(resolver.resolve(action)).toBeNull();
    });
  });

  describe('Unknown/unresolvable actions', () => {
    it('should return null for actions with no tool name', () => {
      const action = makeAction({
        toolName: undefined,
      });

      expect(resolver.resolve(action)).toBeNull();
    });

    it('should return null for verbs not in the pair table and not update-like', () => {
      schemaCache.updateFromToolsList({
        tools: [
          { name: 'transform_data', description: '', inputSchema: {} },
        ],
      });

      const action = makeAction({
        toolName: 'transform_data',
        parameters: { input: 'test' },
      });

      expect(resolver.resolve(action)).toBeNull();
    });
  });

  describe('resolveForTurn', () => {
    it('should resolve actions in reverse sequence order', () => {
      schemaCache.updateFromToolsList({
        tools: [
          {
            name: 'create_item',
            description: '',
            inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          },
          {
            name: 'delete_item',
            description: '',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          },
        ],
      });

      const actions: Action[] = [
        makeAction({
          id: 'act_1',
          sequenceNum: 1,
          toolName: 'create_item',
          parameters: { name: 'First' },
          resultData: { id: 'id_1' },
        }),
        makeAction({
          id: 'act_2',
          sequenceNum: 2,
          toolName: 'create_item',
          parameters: { name: 'Second' },
          resultData: { id: 'id_2' },
        }),
        makeAction({
          id: 'act_3',
          sequenceNum: 3,
          toolName: 'create_item',
          parameters: { name: 'Third' },
          resultData: { id: 'id_3' },
        }),
      ];

      const results = resolver.resolveForTurn(actions);

      expect(results.length).toBe(3);
      // First result should be the last action (highest sequence num)
      expect(results[0]!.inverseParams.id).toBe('id_3');
      expect(results[1]!.inverseParams.id).toBe('id_2');
      expect(results[2]!.inverseParams.id).toBe('id_1');
    });
  });
});
