import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmSolver, LlmSolverConfig } from '../src/undo/llm-solver.js';
import { SchemaCache } from '../src/undo/schema-cache.js';
import { Action } from '../src/journal/database-manager.js';

function makeAction(overrides: Partial<Action>): Action {
  return {
    id: 'act_llm_1',
    sessionId: 'sess_1',
    sequenceNum: 1,
    timestamp: new Date().toISOString(),
    actionType: 'mcp_call',
    state: 'executed',
    ...overrides,
  };
}

function makeSchemaCache(): SchemaCache {
  const cache = new SchemaCache();
  cache.updateFromToolsList({
    tools: [
      {
        name: 'archive_project',
        description: 'Archives a project',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
          },
          required: ['project_id'],
        },
      },
      {
        name: 'unarchive_project',
        description: 'Unarchives a project',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
          },
          required: ['project_id'],
        },
      },
    ],
  });
  return cache;
}

describe('LlmSolver', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('enabled: false', () => {
    it('should return null immediately when disabled', async () => {
      const solver = new LlmSolver({ enabled: false });
      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeNull();
    });
  });

  describe('enabled: true with mocked endpoint', () => {
    it('should return a Class D resolution from a valid LLM response', async () => {
      const mockResponse = {
        inverseTool: 'unarchive_project',
        inverseParams: { project_id: 'proj_123' },
        reasoning: 'Archive can be reversed by unarchive',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(mockResponse) }),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
        model: 'test-model',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({
        toolName: 'archive_project',
        parameters: { project_id: 'proj_123' },
        resultData: { archived: true },
      });

      const result = await solver.solve(action, schemaCache);

      expect(result).toBeTruthy();
      expect(result!.reversibilityClass).toBe('D');
      expect(result!.source).toBe('llm_suggestion');
      expect(result!.inverseTool).toBe('unarchive_project');
      expect(result!.inverseParams.project_id).toBe('proj_123');
      // Valid schema match → confidence 0.3
      expect(result!.confidence).toBe(0.3);
    });

    it('should return confidence 0.1 when suggested tool params miss required fields', async () => {
      const mockResponse = {
        inverseTool: 'unarchive_project',
        inverseParams: {}, // missing required project_id
        reasoning: 'test',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(mockResponse) }),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);

      expect(result).toBeTruthy();
      expect(result!.confidence).toBe(0.1);
    });

    it('should return null when the LLM returns malformed JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'This is not valid JSON at all' }),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeNull();
    });

    it('should return null when the LLM says no inverse is possible (empty inverseTool)', async () => {
      const mockResponse = {
        inverseTool: '',
        inverseParams: {},
        reasoning: 'no inverse possible',
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(mockResponse) }),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeNull();
    });

    it('should return null when endpoint returns HTTP error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeNull();
    });

    it('should return null when fetch throws (network error)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeNull();
    });

    it('should handle LLM response wrapped in markdown code fences', async () => {
      const wrappedResponse = '```json\n{"inverseTool": "unarchive_project", "inverseParams": {"project_id": "p1"}, "reasoning": "test"}\n```';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: wrappedResponse }),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'http://localhost:11434/api/generate',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeTruthy();
      expect(result!.inverseTool).toBe('unarchive_project');
    });

    it('should handle OpenAI-compatible response format', async () => {
      const mockResponse = {
        inverseTool: 'unarchive_project',
        inverseParams: { project_id: 'proj_42' },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const solver = new LlmSolver({
        enabled: true,
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'test-key',
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeTruthy();
      expect(result!.inverseTool).toBe('unarchive_project');
    });

    it('should return null when no endpoint is configured', async () => {
      const solver = new LlmSolver({
        enabled: true,
        // No endpoint!
      });

      const schemaCache = makeSchemaCache();
      const action = makeAction({ toolName: 'archive_project' });

      const result = await solver.solve(action, schemaCache);
      expect(result).toBeNull();
    });
  });
});
