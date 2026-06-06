import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseManager } from '../src/journal/database-manager.js';
import { SnapshotStore, computeSha256 } from '../src/file-safety/snapshot-store.js';
import { ShadowStore } from '../src/file-safety/shadow-store.js';
import { verifyFileHash, resolveConflictPrompt } from '../src/file-safety/conflict-detector.js';

describe('File Safety Layer (Snapshot, Shadow & Conflict Detector)', () => {
  let tempWorkspacePath: string;
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  let snapshotStore: SnapshotStore;
  let shadowStore: ShadowStore;
  const sessionId = 'sess_123';

  beforeEach(() => {
    const tempDir = os.tmpdir();
    tempWorkspacePath = fs.mkdtempSync(path.join(tempDir, 'undomcp_safety_test_'));
    tempDbPath = path.join(tempWorkspacePath, 'journal_test.db');
    
    dbManager = new DatabaseManager(tempDbPath);
    snapshotStore = new SnapshotStore(dbManager);
    shadowStore = new ShadowStore(
      dbManager,
      snapshotStore,
      tempWorkspacePath,
      (filePath) => {
        const rel = path.relative(tempWorkspacePath, filePath);
        return rel.startsWith('ignored') || rel.includes('node_modules');
      }
    );

    // Setup session in DB
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString()
    });
  });

  afterEach(() => {
    dbManager.close();
    try {
      if (fs.existsSync(tempWorkspacePath)) {
        fs.rmSync(tempWorkspacePath, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Clean up error', err);
    }
  });

  // Helper to create a dummy action to satisfy foreign key constraints
  function createDummyAction(actionId: string, sequenceNum: number) {
    dbManager.createAction({
      id: actionId,
      sessionId: sessionId,
      sequenceNum,
      timestamp: new Date().toISOString(),
      actionType: 'file_change',
      state: 'executed'
    });
  }

  it('should compress and decompress snapshots accurately using native deflate', () => {
    const originalText = 'Hello World! This is a test content that needs to be zstd-compressed in SQLite.';
    const buffer = Buffer.from(originalText, 'utf8');

    // Generate snapshot with undefined actionId (null is allowed for foreign key in SQLite)
    const snapId = snapshotStore.createSnapshot(undefined, 'test.txt', buffer, 'pre');
    expect(snapId).toBeDefined();

    // Check entry exists in DB
    const retrieved = dbManager.getSnapshot(snapId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.originalSize).toBe(buffer.length);
    expect(retrieved?.compressedSize).toBeDefined();
    expect(retrieved?.sha256).toBe(computeSha256(buffer));

    // Decompress and verify
    const decompressed = snapshotStore.getSnapshotContent(snapId);
    expect(decompressed).not.toBeNull();
    expect(decompressed?.toString('utf8')).toBe(originalText);
  });

  it('should recursively initialize the file index and create baseline snapshots', () => {
    // Write workspace files
    fs.writeFileSync(path.join(tempWorkspacePath, 'file1.txt'), 'file one');
    fs.mkdirSync(path.join(tempWorkspacePath, 'ignored_dir'));
    fs.writeFileSync(path.join(tempWorkspacePath, 'ignored_dir/file2.txt'), 'file two');
    fs.mkdirSync(path.join(tempWorkspacePath, 'src'));
    fs.writeFileSync(path.join(tempWorkspacePath, 'src/main.js'), 'console.log("hello")');

    shadowStore.initializeIndex();

    // file1.txt should be indexed
    const index1 = dbManager.getFileIndex(path.join(tempWorkspacePath, 'file1.txt'));
    expect(index1).not.toBeNull();
    expect(index1?.sha256).toBe(computeSha256(Buffer.from('file one')));

    // ignored_dir/file2.txt should NOT be indexed
    const index2 = dbManager.getFileIndex(path.join(tempWorkspacePath, 'ignored_dir/file2.txt'));
    expect(index2).toBeNull();

    // src/main.js should be indexed
    const index3 = dbManager.getFileIndex(path.join(tempWorkspacePath, 'src/main.js'));
    expect(index3).not.toBeNull();
  });

  it('should accurately capture modify, delete, and create transitions', () => {
    const file1 = path.join(tempWorkspacePath, 'change-test.txt');
    fs.writeFileSync(file1, 'first version');

    // Index first version as baseline
    shadowStore.initializeIndex();
    const baselineIndex = dbManager.getFileIndex(file1);
    const baselineSnapId = baselineIndex?.snapshotId;

    // Modify file
    fs.writeFileSync(file1, 'second version');

    // Create dummy action first to satisfy foreign key
    createDummyAction('act_update', 1);

    // Update state
    const transition1 = shadowStore.updateFileState(file1, 'act_update', 'modify');
    expect(transition1).not.toBeNull();
    expect(transition1?.operation).toBe('modify');
    expect(transition1?.preSnapshotId).toBe(baselineSnapId);
    expect(transition1?.preHash).toBe(computeSha256(Buffer.from('first version')));
    expect(transition1?.postHash).toBe(computeSha256(Buffer.from('second version')));

    // Delete file
    fs.unlinkSync(file1);
    createDummyAction('act_delete', 2);
    const transition2 = shadowStore.updateFileState(file1, 'act_delete', 'delete');
    expect(transition2).not.toBeNull();
    expect(transition2?.operation).toBe('delete');
    expect(transition2?.preSnapshotId).toBe(transition1?.postSnapshotId);

    // Verify index is removed
    const indexAfterDelete = dbManager.getFileIndex(file1);
    expect(indexAfterDelete).toBeNull();
  });

  it('should verify file hash correctly and detect conflicts', () => {
    const file = path.join(tempWorkspacePath, 'hash-test.txt');
    fs.writeFileSync(file, 'hello');

    const expectedHash = computeSha256(Buffer.from('hello'));
    const wrongHash = computeSha256(Buffer.from('world'));

    expect(verifyFileHash(file, expectedHash)).toBe(true);
    expect(verifyFileHash(file, wrongHash)).toBe(false);
    expect(verifyFileHash(path.join(tempWorkspacePath, 'nonexistent.txt'), expectedHash)).toBe(false);
  });

  it('should default to exit when running in non-interactive mode', async () => {
    const result = await resolveConflictPrompt(path.join(tempWorkspacePath, 'test.txt'));
    expect(result).toBe('exit');
  });
});
