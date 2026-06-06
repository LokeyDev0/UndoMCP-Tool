import * as path from 'path';
import * as fs from 'fs';
import { computeSha256 } from './snapshot-store.js';
export class ShadowStore {
    dbManager;
    snapshotStore;
    workspacePath;
    isIgnored;
    constructor(dbManager, snapshotStore, workspacePath, isIgnored) {
        this.dbManager = dbManager;
        this.snapshotStore = snapshotStore;
        this.workspacePath = path.resolve(workspacePath);
        this.isIgnored = isIgnored;
    }
    /**
     * Recursively scans the workspace directory to build/update the database file index.
     */
    initializeIndex() {
        const scanDir = (dirPath) => {
            let entries = [];
            try {
                entries = fs.readdirSync(dirPath, { withFileTypes: true });
            }
            catch (err) {
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
                }
                else if (entry.isFile()) {
                    this.indexFile(fullPath);
                }
            }
        };
        scanDir(this.workspacePath);
    }
    /**
     * Helper to index a single file from disk.
     */
    indexFile(filePath) {
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
        }
        catch (err) {
            console.error(`[undomcp] Error indexing file ${absolutePath}: ${err.message}`);
        }
    }
    /**
     * Updates the file index and generates transitions for pre-action/post-action logging.
     */
    updateFileState(filePath, actionId, type) {
        const absolutePath = path.resolve(filePath);
        try {
            const existing = this.dbManager.getFileIndex(absolutePath);
            if (type === 'delete') {
                if (!existing)
                    return null;
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
            const postSnapshotId = this.snapshotStore.createSnapshot(undefined, absolutePath, content, 'post');
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
        }
        catch (err) {
            console.error(`[undomcp] Error updating file state for ${absolutePath}: ${err.message}`);
            return null;
        }
    }
}
