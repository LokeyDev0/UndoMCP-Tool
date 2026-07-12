import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../src/journal/database-manager.js';
import { ProxyEngine } from '../src/proxy/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockServerPath = path.join(__dirname, 'mocks', 'mock-server.js');

describe('Proxy Interception and Compensating Calls', () => {
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  const sessionId = 'proxy_intercept_sess_999';
  const turnId = 'proxy_intercept_turn_999';

  beforeEach(() => {
    const tempDir = os.tmpdir();
    tempDbPath = path.join(tempDir, `undomcp_intercept_test_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
    dbManager = new DatabaseManager(tempDbPath);

    // Create session & turn
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
    });
    dbManager.createTurn({
      id: turnId,
      sessionId,
      turnNum: 1,
      promptText: 'Setup test',
      timestamp: new Date().toISOString(),
      actionCount: 0
    });
  });

  afterEach(() => {
    dbManager.close();
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
      if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('should inject undomcp tools into tools/list response', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      agentStdout.on('data', (chunk) => {
        const line = chunk.toString().trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            // Verify mock server tools + custom undomcp tools
            const tools = parsed.result.tools;
            expect(tools.some((t: any) => t.name === 'mock_tool')).toBe(true);
            expect(tools.some((t: any) => t.name === 'undomcp_mark_turn')).toBe(true);
            expect(tools.some((t: any) => t.name === 'undomcp_undo_action')).toBe(true);
            
            proxy.stop();
            resolve();
          }
        } catch (err) {
          proxy.stop();
          reject(err);
        }
      });

      agentStdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    });
  });

  it('should locally intercept undomcp tools and run compensating calls upstream', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      // Populate schema cache first
      proxy.getSchemaCache().updateFromToolsList({
        tools: [
          {
            name: 'create_item',
            description: 'creates',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },
          {
            name: 'delete_item',
            description: 'deletes',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          }
        ]
      });

      // Create a test action that is Class B (create_item -> delete_item)
      dbManager.createAction({
        id: 'act_test_compensate',
        sessionId,
        turnId,
        sequenceNum: 1,
        timestamp: new Date().toISOString(),
        actionType: 'mcp_call',
        toolName: 'create_item',
        parameters: { id: 'item_xyz' },
        state: 'executed'
      });
      // Update results to have the result data
      dbManager.updateActionResults('act_test_compensate', true, { id: 'item_xyz' });

      let step = 0;
      agentStdout.on('data', async (chunk) => {
        const line = chunk.toString().trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 2) {
            // This is the response to undomcp_undo_selection
            const textResult = parsed.result.content[0].text;
            const finalResults = JSON.parse(textResult);
            
            expect(finalResults.length).toBe(1);
            expect(finalResults[0].success).toBe(true);
            expect(finalResults[0].outcome).toBe('marked_undone');

            // Verify action is marked as undone in DB
            const updated = dbManager.getAction('act_test_compensate');
            expect(updated?.state).toBe('undone');

            proxy.stop();
            resolve();
          }
        } catch (err) {
          proxy.stop();
          reject(err);
        }
      });

      // Send the undomcp_undo_action request
      const undoRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'undomcp_undo_action',
          arguments: { action_ids: ['act_test_compensate'] }
        }
      };
      agentStdin.write(JSON.stringify(undoRequest) + '\n');
    });
  });
});
