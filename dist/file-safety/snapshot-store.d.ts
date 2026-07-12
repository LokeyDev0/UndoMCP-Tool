import { DatabaseManager } from '../journal/database-manager.js';
/**
 * Computes the SHA-256 hash of a buffer.
 */
export declare function computeSha256(buffer: Buffer): string;
export declare class SnapshotStore {
    private dbManager;
    constructor(dbManager: DatabaseManager);
    /**
     * Compresses the file content using deflate and saves it in the database.
     * Returns the generated snapshot ID.
     *
     * Files larger than MAX_SNAPSHOT_SIZE (10 MB) are skipped to avoid
     * blocking the proxy and inflating the database.
     */
    createSnapshot(actionId: string | undefined, filePath: string, content: Buffer, role: 'pre' | 'post' | 'baseline'): string;
    /**
     * Retrieves and decompresses the snapshot content from the database.
     */
    getSnapshotContent(snapshotId: string): Buffer | null;
    /**
     * Associates a snapshot with an action.
     */
    associateAction(snapshotId: string, actionId: string): void;
}
