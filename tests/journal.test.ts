import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseManager, Session, Turn, Action, Snapshot } from '../src/journal/database-manager.js';

describe('DatabaseManager & Journaling System', () => {
  let tempDbPath: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    // Generate a unique temporary database file for each test
    const tempDir = os.tmpdir();
    tempDbPath = path.join(tempDir, `undomcp_test_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
    dbManager = new DatabaseManager(tempDbPath);
  });

  afterEach(() => {
    dbManager.close();
    try {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
      // Also clean up SQLite WAL files if they exist
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

  it('should initialize the database file and enable WAL mode', () => {
    expect(fs.existsSync(tempDbPath)).toBe(true);
    expect(dbManager.getPath()).toBe(tempDbPath);
  });

  it('should create and retrieve sessions', () => {
    const session: Session = {
      id: 'sess_1',
      startedAt: new Date().toISOString(),
      workingDirectory: '/test/dir',
      configHash: 'config_sha_123',
      metadata: { client: 'vitest-test' }
    };

    dbManager.createSession(session);

    const retrieved = dbManager.getSession('sess_1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(session.id);
    // Working directory is normalized on insert (path.resolve + lowercase + forward slashes)
    expect(retrieved?.workingDirectory).toBe(dbManager.normalizePath(session.workingDirectory!));
    expect(retrieved?.configHash).toBe(session.configHash);
    expect(retrieved?.metadata).toEqual(session.metadata);
    expect(retrieved?.endedAt).toBeUndefined();

    // End session
    const endedAt = new Date().toISOString();
    dbManager.endSession('sess_1', endedAt);

    const retrievedEnded = dbManager.getSession('sess_1');
    expect(retrievedEnded?.endedAt).toBe(endedAt);
  });

  it('should handle turn creation and auto-increment action counts', () => {
    const turn: Turn = {
      id: 'turn_1',
      sessionId: 'sess_1',
      turnNum: 1,
      promptText: 'Write database test',
      timestamp: new Date().toISOString(),
      actionCount: 0
    };

    // First create session (required for foreign key constraints if session is referenced)
    const session: Session = {
      id: 'sess_1',
      startedAt: new Date().toISOString()
    };
    dbManager.createSession(session);

    dbManager.createTurn(turn);

    const retrieved = dbManager.getTurn('turn_1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.promptText).toBe(turn.promptText);
    expect(retrieved?.actionCount).toBe(0);

    dbManager.incrementTurnActionCount('turn_1');
    const incremented = dbManager.getTurn('turn_1');
    expect(incremented?.actionCount).toBe(1);
  });

  it('should create, log and update actions', () => {
    const session: Session = {
      id: 'sess_1',
      startedAt: new Date().toISOString()
    };
    dbManager.createSession(session);

    const turn: Turn = {
      id: 'turn_1',
      sessionId: 'sess_1',
      turnNum: 1,
      timestamp: new Date().toISOString(),
      actionCount: 0
    };
    dbManager.createTurn(turn);

    const action: Action = {
      id: 'act_1',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      sequenceNum: 1,
      timestamp: new Date().toISOString(),
      actionType: 'mcp_call',
      toolName: 'fs__write_file',
      namespace: 'fs',
      parameters: { path: 'test.txt', content: 'hello' },
      reversibilityClass: 'A',
      inverseTool: 'fs__delete_file',
      inverseParams: { path: 'test.txt' },
      inverseSource: 'explicit_contract',
      inverseConfidence: 1.0,
      state: 'executed'
    };

    dbManager.createAction(action);

    // Turn action count should auto-increment when action specifies turnId
    const turnAfter = dbManager.getTurn('turn_1');
    expect(turnAfter?.actionCount).toBe(1);

    const retrieved = dbManager.getAction('act_1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.toolName).toBe(action.toolName);
    expect(retrieved?.parameters).toEqual(action.parameters);
    expect(retrieved?.inverseParams).toEqual(action.inverseParams);
    expect(retrieved?.resultSuccess).toBeUndefined();

    // Update results
    dbManager.updateActionResults('act_1', true, { bytesWritten: 5 }, 12, 'hash_after_123');

    const updated = dbManager.getAction('act_1');
    expect(updated?.resultSuccess).toBe(1);
    expect(updated?.resultData).toEqual({ bytesWritten: 5 });
    expect(updated?.resultLatencyMs).toBe(12);
    expect(updated?.postHash).toBe('hash_after_123');

    // Update state to undone
    dbManager.updateActionState('act_1', 'undone', new Date().toISOString(), { status: 'reversed' });
    const undone = dbManager.getAction('act_1');
    expect(undone?.state).toBe('undone');
    expect(undone?.undoResult).toEqual({ status: 'reversed' });
  });

  it('should query actions by session and turn', () => {
    const session: Session = { id: 'sess_1', startedAt: new Date().toISOString() };
    dbManager.createSession(session);

    const turn: Turn = { id: 'turn_1', sessionId: 'sess_1', turnNum: 1, timestamp: new Date().toISOString(), actionCount: 0 };
    dbManager.createTurn(turn);

    const action1: Action = {
      id: 'act_1',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      sequenceNum: 1,
      timestamp: new Date().toISOString(),
      actionType: 'mcp_call',
      toolName: 'a',
      state: 'executed'
    };
    const action2: Action = {
      id: 'act_2',
      sessionId: 'sess_1',
      turnId: 'turn_1',
      sequenceNum: 2,
      timestamp: new Date().toISOString(),
      actionType: 'mcp_call',
      toolName: 'b',
      state: 'executed'
    };

    dbManager.createAction(action1);
    dbManager.createAction(action2);

    const sessionActions = dbManager.getActionsForSession('sess_1');
    expect(sessionActions.length).toBe(2);
    expect(sessionActions[0].id).toBe('act_1');
    expect(sessionActions[1].id).toBe('act_2');

    const turnActions = dbManager.getActionsForTurn('turn_1');
    expect(turnActions.length).toBe(2);
  });

  it.skip('should handle checkpoints (not implemented)', () => {
    const session: Session = { id: 'sess_1', startedAt: new Date().toISOString() };
    dbManager.createSession(session);

    const checkpoint: Checkpoint = {
      id: 'cp_1',
      sessionId: 'sess_1',
      name: 'before-refactor',
      sequenceNum: 5,
      createdAt: new Date().toISOString()
    };

    dbManager.createCheckpoint(checkpoint);

    const retrieved = dbManager.getCheckpoint('sess_1', 'before-refactor');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.sequenceNum).toBe(5);
  });

  it('should handle snapshots and file indices', () => {
    const snapshot: Snapshot = {
      id: 'snap_1',
      filePath: '/test/path.txt',
      content: Buffer.from('original content'),
      snapshotRole: 'baseline',
      originalSize: 16,
      compressedSize: 16,
      sha256: 'sha256_mock_hash',
      createdAt: new Date().toISOString()
    };

    dbManager.createSnapshot(snapshot);

    const retrievedSnap = dbManager.getSnapshot('snap_1');
    expect(retrievedSnap).not.toBeNull();
    expect(retrievedSnap?.filePath).toBe(snapshot.filePath);
    expect(retrievedSnap?.content?.toString()).toBe('original content');
  });
});
