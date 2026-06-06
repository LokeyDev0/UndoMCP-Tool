import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { nanoid } from 'nanoid';
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
     */
    createSnapshot(actionId, filePath, content, role) {
        const sha256 = computeSha256(content);
        const originalSize = content.length;
        // Compress content using native deflate
        const compressedBuffer = zlib.deflateSync(content);
        const snapshotId = `snap_${nanoid()}`;
        const snapshot = {
            id: snapshotId,
            actionId,
            filePath,
            content: compressedBuffer,
            snapshotRole: role,
            originalSize,
            compressedSize: compressedBuffer.length,
            sha256,
            createdAt: new Date().toISOString()
        };
        this.dbManager.createSnapshot(snapshot);
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
