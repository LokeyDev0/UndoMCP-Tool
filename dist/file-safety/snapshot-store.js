/**
 * SnapshotStore — Manages compressed file snapshots stored in the database
 * for undo/restore operations.
 */
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { nanoid } from 'nanoid';
/** Maximum file size to snapshot (10 MB) */
const MAX_SNAPSHOT_SIZE = 10 * 1024 * 1024;
/**
 * Computes the SHA-256 hash of a buffer.
 */
export function computeSha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}
export class SnapshotStore {
    dbManager;
    constructor(dbManager) {
        this.dbManager = dbManager;
    }
    /**
     * Compresses the file content using deflate and saves it in the database.
     * Returns the generated snapshot ID.
     *
     * Files larger than MAX_SNAPSHOT_SIZE (10 MB) are skipped to avoid
     * blocking the proxy and inflating the database.
     */
    createSnapshot(actionId, filePath, content, role) {
        if (content.length > MAX_SNAPSHOT_SIZE) {
            console.error(`[undomcp] Skipping snapshot for ${filePath}: file size ${content.length} exceeds ${MAX_SNAPSHOT_SIZE} byte limit.`);
            return 'snap_skipped_too_large';
        }
        const sha256 = computeSha256(content);
        const originalSize = content.length;
        // Compress content using native deflate
        const compressedBuffer = zlib.deflateSync(content);
        const snapshotId = `snap_${nanoid()}`;
        this.dbManager.createSnapshot({
            id: snapshotId,
            actionId,
            filePath,
            snapshotRole: role,
            content: compressedBuffer,
            originalSize,
            compressedSize: compressedBuffer.length,
            sha256,
            createdAt: new Date().toISOString(),
        });
        return snapshotId;
    }
    /**
     * Retrieves and decompresses the snapshot content from the database.
     */
    getSnapshotContent(snapshotId) {
        const snapshot = this.dbManager.getSnapshot(snapshotId);
        if (!snapshot || !snapshot.content)
            return null;
        try {
            return zlib.inflateSync(snapshot.content);
        }
        catch (err) {
            console.error(`[undomcp] Failed to decompress snapshot ${snapshotId}: ${err.message}`);
            return null;
        }
    }
    /**
     * Associates a snapshot with an action.
     */
    associateAction(snapshotId, actionId) {
        this.dbManager.updateSnapshotActionId(snapshotId, actionId);
    }
}
