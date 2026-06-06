import * as path from 'path';
import * as fs from 'fs';
import { DatabaseManager } from '../journal/database-manager.js';
import { SnapshotStore, computeSha256 } from './snapshot-store.js';

export interface FileTransition {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  preSnapshotId?: string;
  postSnapshotId?: string;
  preHash?: string;
  postHash?: string;
}

export class ShadowStore {
  private dbManager: DatabaseManager;
  private snapshotStore: SnapshotStore;
  private workspacePath: string;
  private isIgnored: (filePath: string) => boolean;

  constructor(
    dbManager: DatabaseManager,
    snapshotStore: SnapshotStore,
    workspacePath: string,
    isIgnored: (filePath: string) => boolean
  ) {
    this.dbManager = dbManager;
    this.snapshotStore = snapshotStore;
    this.workspacePath = path.resolve(workspacePath);
    this.isIgnored = isIgnored;
  }

  /**
   * Recursively scans the workspace directory to build/update the database file index.
   */
  public initializeIndex(): void {
    const scanDir = (dirPath: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (err: any) {
        console.error(`[undomcp] Failed to read directory ${dirPath}: ${err.message}`);
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (this.isIgnored(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile()) {
          this.indexFile(fullPath);
        }
      }
    };

    scanDir(this.workspacePath);
  }

  /**
   * Helper to index a single file from disk.
   */
  private indexFile(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    try {
      const stats = fs.statSync(absolutePath);
      const existing = this.dbManager.getFileIndex(absolutePath);

      // If already indexed and matches mtime/size on disk, skip hashing content
      if (existing && existing.sizeBytes === stats.size && existing.mtimeMs === stats.mtimeMs) {
        return;
      }

      const content = fs.readFileSync(absolutePath);
      const sha256 = computeSha256(content);

      // If SHA matches, just update mtime/size index
      if (existing && existing.sha256 === sha256) {
        this.dbManager.setFileIndex({
          filePath: absolutePath,
          snapshotId: existing.snapshotId,
          sha256,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          updatedAt: new Date().toISOString()
        });
        return;
      }

      // Generate new baseline snapshot
      const snapshotId = this.snapshotStore.createSnapshot(undefined, absolutePath, content, 'baseline');

      this.dbManager.setFileIndex({
        filePath: absolutePath,
        snapshotId,
        sha256,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        updatedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error(`[undomcp] Error indexing file ${absolutePath}: ${err.message}`);
    }
  }

  /**
   * Updates the file index and generates transitions for pre-action/post-action logging.
   */
  public updateFileState(
    filePath: string,
    actionId: string,
    type: 'create' | 'modify' | 'delete'
  ): FileTransition | null {
    const absolutePath = path.resolve(filePath);
    try {
      const existing = this.dbManager.getFileIndex(absolutePath);

      if (type === 'delete') {
        if (!existing) return null;

        const preSnapshotId = existing.snapshotId;
        const preHash = existing.sha256;

        this.dbManager.deleteFileIndex(absolutePath);

        return {
          filePath: absolutePath,
          operation: 'delete',
          preSnapshotId,
          preHash
        };
      }

      // Handle create or modify
      if (!fs.existsSync(absolutePath)) {
        return null;
      }

      const stats = fs.statSync(absolutePath);
      const content = fs.readFileSync(absolutePath);
      const sha256 = computeSha256(content);

      if (existing && existing.sha256 === sha256) {
        // Update metadata index only, no content changes
        this.dbManager.setFileIndex({
          filePath: absolutePath,
          snapshotId: existing.snapshotId,
          sha256,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          updatedAt: new Date().toISOString()
        });
        return null;
      }

      const preSnapshotId = existing?.snapshotId;
      const preHash = existing?.sha256;

      const postSnapshotId = this.snapshotStore.createSnapshot(actionId, absolutePath, content, 'post');

      this.dbManager.setFileIndex({
        filePath: absolutePath,
        snapshotId: postSnapshotId,
        sha256,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        updatedAt: new Date().toISOString()
      });

      return {
        filePath: absolutePath,
        operation: existing ? 'modify' : 'create',
        preSnapshotId,
        preHash,
        postSnapshotId,
        postHash: sha256
      };
    } catch (err: any) {
      console.error(`[undomcp] Error updating file state for ${absolutePath}: ${err.message}`);
      return null;
    }
  }
}
