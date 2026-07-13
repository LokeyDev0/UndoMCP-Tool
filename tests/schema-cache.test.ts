import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaCache } from '../src/undo/schema-cache.js';

describe('SchemaCache', () => {
  let cache: SchemaCache;

  beforeEach(() => {
    cache = new SchemaCache();
  });

  describe('updateFromToolsList', () => {
    it('should populate the cache from a realistic tools/list response', () => {
      const toolsListResult = {
        tools: [
          {
            name: 'create_item',
            description: 'Creates a new item',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
              },
              required: ['name'],
            },
          },
          {
            name: 'delete_item',
            description: 'Deletes an item by ID',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            },
          },
          {
            name: 'list_items',
            description: 'Lists all items',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };

      cache.updateFromToolsList(toolsListResult);

      expect(cache.size()).toBe(3);
      expect(cache.getToolSchema('create_item')).toBeTruthy();
      expect(cache.getToolSchema('delete_item')).toBeTruthy();
      expect(cache.getToolSchema('list_items')).toBeTruthy();
    });

    it('should handle empty or malformed input gracefully', () => {
      cache.updateFromToolsList(null);
      expect(cache.size()).toBe(0);

      cache.updateFromToolsList({});
      expect(cache.size()).toBe(0);

      cache.updateFromToolsList({ tools: 'not-an-array' });
      expect(cache.size()).toBe(0);
    });

    it('should skip tools with missing names', () => {
      cache.updateFromToolsList({
        tools: [
          { name: 'valid_tool', description: 'valid' },
          { description: 'no name field' },
          { name: '', description: 'empty name' },
        ],
      });

      // '' is a valid string key, but we check typeof === string
      expect(cache.size()).toBe(2);
    });

    it('should replace stale data on subsequent calls', () => {
      cache.updateFromToolsList({
        tools: [
          { name: 'old_tool', description: 'old' },
        ],
      });

      expect(cache.size()).toBe(1);
      expect(cache.getToolSchema('old_tool')).toBeTruthy();

      cache.updateFromToolsList({
        tools: [
          { name: 'new_tool_a', description: 'new A' },
          { name: 'new_tool_b', description: 'new B' },
        ],
      });

      expect(cache.size()).toBe(2);
      expect(cache.getToolSchema('old_tool')).toBeNull();
      expect(cache.getToolSchema('new_tool_a')).toBeTruthy();
      expect(cache.getToolSchema('new_tool_b')).toBeTruthy();
    });
  });

  describe('getToolSchema', () => {
    it('should return null for non-existent tool names', () => {
      expect(cache.getToolSchema('nonexistent')).toBeNull();
    });

    it('should return the correct schema for a known tool', () => {
      cache.updateFromToolsList({
        tools: [
          {
            name: 'my_tool',
            description: 'My tool description',
            inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          },
        ],
      });

      const schema = cache.getToolSchema('my_tool');
      expect(schema).toBeTruthy();
      expect(schema!.name).toBe('my_tool');
      expect(schema!.description).toBe('My tool description');
      expect(schema!.inputSchema.properties.x.type).toBe('number');
    });
  });

  describe('getAllSchemas', () => {
    it('should return an empty array when the cache is empty', () => {
      expect(cache.getAllSchemas()).toEqual([]);
    });

    it('should return all cached schemas', () => {
      cache.updateFromToolsList({
        tools: [
          { name: 'a', description: 'tool a' },
          { name: 'b', description: 'tool b' },
        ],
      });

      const all = cache.getAllSchemas();
      expect(all.length).toBe(2);
      expect(all.map(s => s.name).sort()).toEqual(['a', 'b']);
    });
  });

  describe('findToolsByPattern', () => {
    beforeEach(() => {
      cache.updateFromToolsList({
        tools: [
          { name: 'create_item', description: '' },
          { name: 'create_user', description: '' },
          { name: 'delete_item', description: '' },
          { name: 'delete_user', description: '' },
          { name: 'list_items', description: '' },
          { name: 'update_config', description: '' },
        ],
      });
    });

    it('should find tools matching a create_ pattern', () => {
      const matches = cache.findToolsByPattern(/^create_/);
      expect(matches.length).toBe(2);
      expect(matches.map(s => s.name).sort()).toEqual(['create_item', 'create_user']);
    });

    it('should find tools matching a delete_ pattern', () => {
      const matches = cache.findToolsByPattern(/^delete_/);
      expect(matches.length).toBe(2);
    });

    it('should return an empty array when nothing matches', () => {
      const matches = cache.findToolsByPattern(/^nonexistent_/);
      expect(matches.length).toBe(0);
    });
  });

  describe('getRequiredParams', () => {
    it('should return required fields from a tool schema', () => {
      cache.updateFromToolsList({
        tools: [
          {
            name: 'delete_item',
            description: '',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                force: { type: 'boolean' },
              },
              required: ['id'],
            },
          },
        ],
      });

      const required = cache.getRequiredParams('delete_item');
      expect(required).toEqual(['id']);
    });

    it('should return an empty array for tools without required fields', () => {
      cache.updateFromToolsList({
        tools: [
          {
            name: 'list_items',
            description: '',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      expect(cache.getRequiredParams('list_items')).toEqual([]);
    });

    it('should return an empty array for unknown tools', () => {
      expect(cache.getRequiredParams('unknown_tool')).toEqual([]);
    });
  });

  describe('getPropertyNames', () => {
    it('should return property names from a tool schema', () => {
      cache.updateFromToolsList({
        tools: [
          {
            name: 'create_item',
            description: '',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                priority: { type: 'number' },
              },
            },
          },
        ],
      });

      const props = cache.getPropertyNames('create_item');
      expect(props.sort()).toEqual(['category', 'name', 'priority']);
    });

    it('should return an empty array for unknown tools', () => {
      expect(cache.getPropertyNames('unknown_tool')).toEqual([]);
    });
  });
});
