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

describe('ProxyEngine Turn Tracking and Clustering', () => {
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  const sessionId = 'turn_test_sess_123';

  beforeEach(() => {
    const tempDir = os.tmpdir();
    tempDbPath = path.join(tempDir, `undomcp_turn_test_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
    dbManager = new DatabaseManager(tempDbPath);

    // Create session
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: process.cwd()
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

  it('should auto-create a turn and link consecutive calls within the threshold to the same turn', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId,
        turnIdleTimeoutMs: 1000 // 1 second timeout
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      let step = 0;
      agentStdout.on('data', async (chunk) => {
        const line = chunk.toString().trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            // First call response
            step = 1;
            // Immediate second call
            const request2 = {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'mock_server__write_file',
                arguments: { path: 'file2.txt', content: 'world' }
              }
            };
            agentStdin.write(JSON.stringify(request2) + '\n');
          } else if (parsed.id === 2) {
            // Second call response
            await new Promise(r => setTimeout(r, 100)); // wait for DB insert
            
            const actions = dbManager.getActionsForSession(sessionId);
            expect(actions.length).toBe(2);
            expect(actions[0].turnId).toBeDefined();
            expect(actions[1].turnId).toBeDefined();
            expect(actions[0].turnId).toBe(actions[1].turnId);

            const turn = dbManager.getTurn(actions[0].turnId!);
            expect(turn?.actionCount).toBe(2);
            expect(turn?.turnNum).toBe(1);

            proxy.stop();
            resolve();
          }
        } catch (err) {
          proxy.stop();
          reject(err);
        }
      });

      const request1 = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: { path: 'file1.txt', content: 'hello' }
        }
      };
      agentStdin.write(JSON.stringify(request1) + '\n');
    });
  });

  it('should auto-create a new turn when the idle timeout threshold is exceeded', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId,
        turnIdleTimeoutMs: 150 // very short timeout for testing
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      agentStdout.on('data', async (chunk) => {
        const line = chunk.toString().trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            // Wait 250ms to exceed 150ms timeout
            await new Promise(r => setTimeout(r, 250));

            const request2 = {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'mock_server__write_file',
                arguments: { path: 'file2.txt', content: 'world' }
              }
            };
            agentStdin.write(JSON.stringify(request2) + '\n');
          } else if (parsed.id === 2) {
            await new Promise(r => setTimeout(r, 100)); // wait for DB insert
            
            const actions = dbManager.getActionsForSession(sessionId);
            expect(actions.length).toBe(2);
            expect(actions[0].turnId).toBeDefined();
            expect(actions[1].turnId).toBeDefined();
            expect(actions[0].turnId).not.toBe(actions[1].turnId); // should be different turns!

            const turn1 = dbManager.getTurn(actions[0].turnId!);
            const turn2 = dbManager.getTurn(actions[1].turnId!);
            expect(turn1?.turnNum).toBe(1);
            expect(turn2?.turnNum).toBe(2);
            expect(turn1?.actionCount).toBe(1);
            expect(turn2?.actionCount).toBe(1);

            proxy.stop();
            resolve();
          }
        } catch (err) {
          proxy.stop();
          reject(err);
        }
      });

      const request1 = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: { path: 'file1.txt', content: 'hello' }
        }
      };
      agentStdin.write(JSON.stringify(request1) + '\n');
    });
  });

  it('should intercept undomcp_mark_turn and immediately create a new turn with prompt text', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        dbManager,
        sessionId,
        turnIdleTimeoutMs: 10000 // high timeout so it won't time out
      });

      proxy.start(agentStdin, agentStdout, agentStderr);

      let step = 0;
      agentStdout.on('data', async (chunk) => {
        const line = chunk.toString().trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            // First call response
            // Now invoke active turn marking
            const markRequest = {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: {
                name: 'undomcp_mark_turn',
                arguments: { prompt_text: 'Perform second phase' }
              }
            };
            agentStdin.write(JSON.stringify(markRequest) + '\n');
          } else if (parsed.id === 2) {
            // Check success of mark turn response
            expect(parsed.result.content[0].text).toBe('Turn marked successfully.');

            // Call next tool call, which should be linked to the marked turn
            const request3 = {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'mock_server__write_file',
                arguments: { path: 'file2.txt', content: 'world' }
              }
            };
            agentStdin.write(JSON.stringify(request3) + '\n');
          } else if (parsed.id === 3) {
            await new Promise(r => setTimeout(r, 100)); // wait for DB insert
            
            const actions = dbManager.getActionsForSession(sessionId);
            // Since undomcp_mark_turn is handled locally, it is NOT logged in actions table as an mcp_call to upstream (or is it? No, it's intercepted and not forwarded, so only original calls are in actions)
            // Wait, let's verify: request1 (id 1) and request3 (id 3) are in actions.
            expect(actions.length).toBe(2);
            expect(actions[0].turnId).toBeDefined();
            expect(actions[1].turnId).toBeDefined();
            expect(actions[0].turnId).not.toBe(actions[1].turnId);

            const turn2 = dbManager.getTurn(actions[1].turnId!);
            expect(turn2?.promptText).toBe('Perform second phase');
            expect(turn2?.turnNum).toBe(2);

            proxy.stop();
            resolve();
          }
        } catch (err) {
          proxy.stop();
          reject(err);
        }
      });

      const request1 = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: { path: 'file1.txt', content: 'hello' }
        }
      };
      agentStdin.write(JSON.stringify(request1) + '\n');
    });
  });

  it('should recover turnId and check timeout correctly on process restart', async () => {
    // 1. Start a proxy session, log one tool call, then stop the proxy
    const agentStdin1 = new PassThrough();
    const agentStdout1 = new PassThrough();
    const agentStderr1 = new PassThrough();

    const proxy1 = new ProxyEngine({
      command: 'node',
      args: [mockServerPath],
      dbManager,
      sessionId,
      turnIdleTimeoutMs: 200 // short timeout
    });

    proxy1.start(agentStdin1, agentStdout1, agentStderr1);

    await new Promise<void>((resolve, reject) => {
      agentStdout1.on('data', async (chunk) => {
        try {
          const parsed = JSON.parse(chunk.toString().trim());
          if (parsed.id === 1) {
            await new Promise(r => setTimeout(r, 100)); // wait for DB insert
            proxy1.stop();
            resolve();
          }
        } catch (err) {
          proxy1.stop();
          reject(err);
        }
      });

      agentStdin1.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: { path: 'restart_file1.txt', content: 'restart1' }
        }
      }) + '\n');
    });

    // Verify first action and turn were created
    const actionsBefore = dbManager.getActionsForSession(sessionId);
    expect(actionsBefore.length).toBe(1);
    const initialTurnId = actionsBefore[0].turnId;
    expect(initialTurnId).toBeDefined();

    // 2. Start a new proxy session in the same session immediately (before 200ms expires)
    const agentStdin2 = new PassThrough();
    const agentStdout2 = new PassThrough();
    const agentStderr2 = new PassThrough();

    const proxy2 = new ProxyEngine({
      command: 'node',
      args: [mockServerPath],
      dbManager,
      sessionId,
      turnIdleTimeoutMs: 200
    });

    proxy2.start(agentStdin2, agentStdout2, agentStderr2);

    await new Promise<void>((resolve, reject) => {
      agentStdout2.on('data', async (chunk) => {
        try {
          const parsed = JSON.parse(chunk.toString().trim());
          if (parsed.id === 2) {
            await new Promise(r => setTimeout(r, 100)); // wait for DB insert
            proxy2.stop();
            resolve();
          }
        } catch (err) {
          proxy2.stop();
          reject(err);
        }
      });

      agentStdin2.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: { path: 'restart_file2.txt', content: 'restart2' }
        }
      }) + '\n');
    });

    const actionsAfter2 = dbManager.getActionsForSession(sessionId);
    expect(actionsAfter2.length).toBe(2);
    // Timeout was not exceeded (restarted and run immediately), so it should reuse the turn ID!
    expect(actionsAfter2[1].turnId).toBe(initialTurnId);

    // 3. Start a new proxy session after waiting for the timeout (wait 300ms)
    await new Promise(r => setTimeout(r, 300));

    const agentStdin3 = new PassThrough();
    const agentStdout3 = new PassThrough();
    const agentStderr3 = new PassThrough();

    const proxy3 = new ProxyEngine({
      command: 'node',
      args: [mockServerPath],
      dbManager,
      sessionId,
      turnIdleTimeoutMs: 200
    });

    proxy3.start(agentStdin3, agentStdout3, agentStderr3);

    await new Promise<void>((resolve, reject) => {
      agentStdout3.on('data', async (chunk) => {
        try {
          const parsed = JSON.parse(chunk.toString().trim());
          if (parsed.id === 3) {
            await new Promise(r => setTimeout(r, 100)); // wait for DB insert
            proxy3.stop();
            resolve();
          }
        } catch (err) {
          proxy3.stop();
          reject(err);
        }
      });

      agentStdin3.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'mock_server__write_file',
          arguments: { path: 'restart_file3.txt', content: 'restart3' }
        }
      }) + '\n');
    });

    const actionsFinal = dbManager.getActionsForSession(sessionId);
    expect(actionsFinal.length).toBe(3);
    // Timeout was exceeded, so it should have created a new turn ID!
    expect(actionsFinal[2].turnId).not.toBe(initialTurnId);
    
    const turn3 = dbManager.getTurn(actionsFinal[2].turnId!);
    expect(turn3?.turnNum).toBe(2);
  });
});
