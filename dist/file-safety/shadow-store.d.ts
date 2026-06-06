import { DatabaseManager } from '../journal/database-manager.js';
import { SnapshotStore } from './snapshot-store.js';
export interface FileTransition {
    filePath: string;
    operation: 'create' | 'modify' | 'delete';
    preSnapshotId?: string;
    postSnapshotId?: string;
    preHash?: string;
    postHash?: string;
}
export declare class ShadowStore {
    private dbManager;
    private snapshotStore;
    private workspacePath;
    private isIgnored;
    constructor(dbManager: DatabaseManager, snapshotStore: SnapshotStore, workspacePath: string, isIgnored: (filePath: string) => boolean);
    /**
     * Recursively scans the workspace directory to build/update the database file index.
     */
    initializeIndex(): void;
    /**
     * Helper to index a single file from disk.
     */
    private indexFile;
    /**
     * Updates the file index and generates transitions for pre-action/post-action logging.
     */
    updateFileState(filePath: string, actionId: string, type: 'create' | 'modify' | 'delete'): FileTransition | null;
}
