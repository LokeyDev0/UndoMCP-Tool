import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseManager } from '../src/journal/database-manager.js';
import { SnapshotStore, computeSha256 } from '../src/file-safety/snapshot-store.js';
import { verifyFileHash, resolveConflictPrompt } from '../src/file-safety/conflict-detector.js';

describe('File Safety Layer (Snapshot & Conflict Detector)', () => {
  let tempWorkspacePath: string;
  let tempDbPath: string;
  let dbManager: DatabaseManager;
  let snapshotStore: SnapshotStore;
  const sessionId = 'sess_123';

  beforeEach(() => {
    const tempDir = os.tmpdir();
    tempWorkspacePath = fs.mkdtempSync(path.join(tempDir, 'undomcp_safety_test_'));
    tempDbPath = path.join(tempWorkspacePath, 'journal_test.db');
    
    dbManager = new DatabaseManager(tempDbPath);
    snapshotStore = new SnapshotStore(dbManager);

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

  describe('SnapshotStore', () => {
    it('should compress and decompress snapshots accurately using native deflate', () => {
      const originalText = 'Hello World! This is a test content that needs to be compressed in SQLite.';
      const buffer = Buffer.from(originalText, 'utf8');

      const snapId = snapshotStore.createSnapshot(undefined, 'test.txt', buffer, 'pre');
      expect(snapId).toBeDefined();
      expect(snapId).toMatch(/^snap_/);

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

    it('should skip files larger than 10MB', () => {
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024, 'x');
      const snapId = snapshotStore.createSnapshot(undefined, 'large.bin', largeBuffer, 'pre');
      expect(snapId).toBe('snap_skipped_too_large');
    });

    it('should return null for non-existent snapshot', () => {
      const content = snapshotStore.getSnapshotContent('snap_nonexistent');
      expect(content).toBeNull();
    });

    it('should associate action with snapshot', () => {
      // Create an action to associate with
      dbManager.createAction({
        id: 'act_new',
        sessionId,
        sequenceNum: 1,
        timestamp: new Date().toISOString(),
        actionType: 'mcp_call',
        state: 'executed',
      });

      const buffer = Buffer.from('test content', 'utf8');
      const snapId = snapshotStore.createSnapshot(undefined, 'test.txt', buffer, 'pre');
      
      // Change association
      snapshotStore.associateAction(snapId, 'act_new');
      
      const retrieved = dbManager.getSnapshot(snapId);
      expect(retrieved?.actionId).toBe('act_new');
    });
  });

  describe('computeSha256', () => {
    it('should produce consistent hash for the same content', () => {
      const buffer = Buffer.from('hello world');
      const hash1 = computeSha256(buffer);
      const hash2 = computeSha256(buffer);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('should produce different hash for different content', () => {
      const hash1 = computeSha256(Buffer.from('hello'));
      const hash2 = computeSha256(Buffer.from('world'));
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyFileHash', () => {
    it('should verify file hash correctly', () => {
      const file = path.join(tempWorkspacePath, 'hash-test.txt');
      fs.writeFileSync(file, 'hello');

      const expectedHash = computeSha256(Buffer.from('hello'));
      const wrongHash = computeSha256(Buffer.from('world'));

      expect(verifyFileHash(file, expectedHash)).toBe(true);
      expect(verifyFileHash(file, wrongHash)).toBe(false);
    });

    it('should return false for non-existent file', () => {
      const hash = computeSha256(Buffer.from('hello'));
      expect(verifyFileHash(path.join(tempWorkspacePath, 'nonexistent.txt'), hash)).toBe(false);
    });
  });

  describe('resolveConflictPrompt', () => {
    it('should default to exit when running in non-interactive mode', async () => {
      const result = await resolveConflictPrompt(path.join(tempWorkspacePath, 'test.txt'));
      expect(result).toBe('exit');
    });
  });
});
