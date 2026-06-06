import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseManager } from '../src/journal/database-manager.js';

describe('CLI Entrypoint (index.ts)', () => {
  let tempDir: string;
  let tempDbPath: string;
  let originalEnvDb: string | undefined;

  beforeEach(() => {
    // We override ~/.undomcp path by mocking the homedir or using options.
    // Wait! DatabaseManager default path uses os.homedir().
    // Can we temporarily override os.homedir() or set a custom DB path?
    // Since DatabaseManager defaults to `path.join(os.homedir(), '.undomcp', 'journal.db')`,
    // we can override the USERPROFILE or HOME environment variable so DatabaseManager opens our temp DB!
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undomcp-cli-test-'));
    
    // Set HOME (macOS/Linux) and USERPROFILE (Windows) env variables
    originalEnvDb = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    // Restore env variables
    if (originalEnvDb) {
      process.env.USERPROFILE = originalEnvDb;
    } else {
      delete process.env.USERPROFILE;
    }
    delete process.env.HOME;

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should print "No active session found" when database does not exist or has no active session', () => {
    const stdout = execSync('node dist/index.js', { encoding: 'utf8' });
    expect(stdout).toContain('No active session found.');
  });

  it('should print session summary when an active session is found', () => {
    // Create an active session and turn in the database
    const dbDir = path.join(tempDir, '.undomcp');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbManager = new DatabaseManager(path.join(dbDir, 'journal.db'));
    
    const sessionId = 'cli_session_1';
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: process.cwd()
    });

    dbManager.createTurn({
      id: 'turn_1',
      sessionId,
      turnNum: 1,
      promptText: 'Create a test file',
      timestamp: new Date().toISOString(),
      actionCount: 0
    });

    dbManager.createAction({
      id: 'act_1',
      sessionId,
      turnId: 'turn_1',
      sequenceNum: 1,
      timestamp: new Date().toISOString(),
      actionType: 'mcp_call',
      toolName: 'write_file',
      state: 'executed',
      metadata: { label: 'Modify file: test.txt' }
    });

    dbManager.close();

    const stdout = execSync('node dist/index.js', { encoding: 'utf8' });
    expect(stdout).toContain('Active session found: cli_session_1');
    expect(stdout).toContain('**Turn #1**: "Create a test file"');
    expect(stdout).toContain('- [ ] Modify file: test.txt');
  });
});
