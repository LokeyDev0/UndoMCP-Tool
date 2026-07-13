import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { ProxyEngine } from '../src/proxy/engine.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('ProxyEngine', () => {
  it('should intercept requests and responses and forward transparently', async () => {
    // Create a temporary script for upstream process to avoid any -e escaping issues on Windows
    const tempDir = os.tmpdir();
    const mockUpstreamPath = path.join(tempDir, `mock-upstream-${Date.now()}-${Math.random().toString(36).substring(7)}.js`);
    
    // The mock upstream reads json lines, parses them, and replies with a valid json-rpc response
    const mockUpstreamCode = `
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });
      
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const req = JSON.parse(line);
          if (req.method === 'ping') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: 'pong'
            }));
          } else {
            console.log(line); // echo back
          }
        } catch (e) {
          console.log(line);
        }
      });
    `;
    
    fs.writeFileSync(mockUpstreamPath, mockUpstreamCode);

    try {
      const onRequest = vi.fn();
      const onResponse = vi.fn();

      const engine = new ProxyEngine({
        command: 'node',
        args: [mockUpstreamPath],
        onRequest,
        onResponse,
      });

      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      engine.start(agentStdin, agentStdout, agentStderr);

      // Helper to capture stdout lines
      const outputLines: string[] = [];
      agentStdout.on('data', (data) => {
        const str = data.toString();
        // Split by newline and filter out empty
        const lines = str.split('\\n').join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
        outputLines.push(...lines);
      });

      // Send a request
      const requestPayload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: {}
      };
      
      agentStdin.write(JSON.stringify(requestPayload) + '\n');

      // Wait for output response (up to 3 seconds)
      await new Promise<void>((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
          if (outputLines.length > 0) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - startTime > 3000) {
            clearInterval(interval);
            reject(new Error('Timeout waiting for proxy response'));
          }
        }, 50);
      });

      // Stop engine
      engine.stop();

      // Check results
      expect(outputLines.length).toBe(1);
      const response = JSON.parse(outputLines[0]);
      expect(response.id).toBe(1);
      expect(response.result).toBe('pong');

      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(onRequest).toHaveBeenCalledWith(requestPayload);

      expect(onResponse).toHaveBeenCalledTimes(1);
      expect(onResponse).toHaveBeenCalledWith(
        requestPayload,
        expect.objectContaining({ id: 1, result: 'pong' })
      );
    } finally {
      try {
        if (fs.existsSync(mockUpstreamPath)) {
          fs.unlinkSync(mockUpstreamPath);
        }
      } catch (err) {
        // Ignore unlink errors
      }
    }
  });

  it.skip('should initialize WorkspaceFileWatcher and log file change events to the database (legacy - WorkspaceFileWatcher removed)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undomcp-engine-watch-'));
    const tempDbPath = path.join(tempDir, 'test.db');
    const { DatabaseManager } = await import('../src/journal/database-manager.js');
    const dbManager = new DatabaseManager(tempDbPath);

    const sessionId = 'test_sess_engine_watch';
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: tempDir
    });

    const mockUpstreamPath = path.join(tempDir, 'mock-upstream.js');
    fs.writeFileSync(mockUpstreamPath, `
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });
      rl.on('line', (line) => {
        console.log(line);
      });
    `);

    const engine = new ProxyEngine({
      command: 'node',
      args: [mockUpstreamPath],
      dbManager,
      sessionId
    });

    const agentStdin = new PassThrough();
    const agentStdout = new PassThrough();
    const agentStderr = new PassThrough();

    engine.start(agentStdin, agentStdout, agentStderr);
    if (engine.watcherPromise) {
      await engine.watcherPromise;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Write a file to trigger file creation
    const filePath = path.join(tempDir, 'created-file.txt');
    fs.writeFileSync(filePath, 'Hello World');

    // Wait for file watch event to propagate and be logged to SQLite
    await new Promise<void>((resolve, reject) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        const actions = dbManager.getActionsForSession(sessionId);
        const fileChangeAction = actions.find(a => a.actionType === 'file_change');
        if (fileChangeAction) {
          clearInterval(interval);
          expect(fileChangeAction.parameters?.operation).toBe('create');
          expect(fileChangeAction.parameters?.filePath).toBe(filePath);
          resolve();
        } else if (Date.now() - startTime > 5000) {
          clearInterval(interval);
          reject(new Error('Timeout waiting for file_change event to log to db'));
        }
      }, 100);
    });

    engine.stop();
    dbManager.close();

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }, 10000);
});
