import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('ProxyEngine Transaction Logging', () => {
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  const sessionId = 'test_sess_123';
  const turnId = 'test_turn_123';

  beforeEach(() => {
    const tempDir = os.tmpdir();
    tempDbPath = path.join(tempDir, `undomcp_logging_test_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
    dbManager = new DatabaseManager(tempDbPath);

    // Create session and turn as required by foreign key constraints
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: process.cwd()
    });

    dbManager.createTurn({
      id: turnId,
      sessionId,
      turnNum: 1,
      promptText: 'Create a test file',
      timestamp: new Date().toISOString(),
      actionCount: 0
    });
  });

  afterEach(() => {
    dbManager.close();
    try {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
      if (fs.existsSync(`${tempDbPath}-wal`)) {
        fs.unlinkSync(`${tempDbPath}-wal`);
      }
      if (fs.existsSync(`${tempDbPath}-shm`)) {
        fs.unlinkSync(`${tempDbPath}-shm`);
      }
    } catch (err) {
      console.error('Clean up error', err);
    }
  });

  it('should log tools/call request and response transactions with accurate details and labels', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId,
        turnId
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      agentStdout.on('data', async (chunk) => {
        const line = chunk.toString().trim();
        if (!line.includes('\n') || line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === 1) {
              // Wait a brief moment for async db update to finish
              await new Promise(r => setTimeout(r, 100));

              // Retrieve actions
              const actions = dbManager.getActionsForSession(sessionId);
              expect(actions.length).toBe(1);
              
              const action = actions[0];
              expect(action.turnId).toBe(turnId);
              expect(action.sequenceNum).toBe(1);
              expect(action.actionType).toBe('mcp_call');
              expect(action.toolName).toBe('write_file');
              expect(action.namespace).toBe('mock_server');
              expect(action.parameters).toEqual({ path: 'myfile.txt', content: 'hello' });
              expect(action.metadata?.label).toBe('Modify file: myfile.txt');
              
              // Post-response verification
              expect(action.resultSuccess).toBe(1);
              expect(action.resultData?.content[0].text).toContain('Echo');
              expect(action.resultLatencyMs).toBeGreaterThanOrEqual(0);

              proxy.stop();
              resolve();
            }
          } catch (err) {
            proxy.stop();
            reject(err);
          }
        }
      });

      // Send tools/call request
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: {
            path: 'myfile.txt',
            content: 'hello'
          }
        }
      };
      agentStdin.write(JSON.stringify(request) + '\n');
    });
  });

  it('should parse command tool calls and assign the correct human-readable execution labels', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId,
        turnId
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      agentStdout.on('data', async (chunk) => {
        const line = chunk.toString().trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 2) {
            await new Promise(r => setTimeout(r, 100));

            const actions = dbManager.getActionsForSession(sessionId);
            const action = actions.find(a => a.toolName === 'run_command');
            expect(action).toBeDefined();
            expect(action?.toolName).toBe('run_command');
            expect(action?.namespace).toBeUndefined();
            expect(action?.metadata?.label).toBe('Execute command: npm run build');

            proxy.stop();
            resolve();
          }
        } catch (err) {
          proxy.stop();
          reject(err);
        }
      });

      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'run_command',
          arguments: {
            command: 'npm run build'
          }
        }
      };
      agentStdin.write(JSON.stringify(request) + '\n');
    });
  });
});
