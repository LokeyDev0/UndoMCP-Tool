export interface Session {
    id: string;
    startedAt: string;
    endedAt?: string;
    workingDirectory?: string;
    configHash?: string;
    metadata?: Record<string, any>;
}
export interface Turn {
    id: string;
    sessionId: string;
    turnNum: number;
    promptText?: string;
    timestamp: string;
    actionCount: number;
}
export interface Action {
    id: string;
    sessionId: string;
    turnId?: string;
    sequenceNum: number;
    timestamp: string;
    actionType: 'mcp_call' | 'file_change' | 'checkpoint';
    toolName?: string;
    namespace?: string;
    parameters?: Record<string, any>;
    resultSuccess?: number;
    resultData?: Record<string, any>;
    resultLatencyMs?: number;
    preHash?: string;
    postHash?: string;
    reversibilityClass?: 'A' | 'B' | 'C' | 'D';
    inverseTool?: string;
    inverseParams?: Record<string, any>;
    inverseSource?: 'explicit_contract' | 'filesystem_shadow' | 'heuristic' | 'llm_suggestion';
    inverseConfidence?: number;
    preSnapshotId?: string;
    postSnapshotId?: string;
    state: 'executed' | 'undone' | 'undo_failed';
    undoneAt?: string;
    undoResult?: Record<string, any>;
    undoError?: string;
    metadata?: Record<string, any>;
}
export interface Snapshot {
    id: string;
    actionId?: string;
    filePath: string;
    content?: Buffer;
    snapshotRole: 'baseline' | 'pre' | 'post';
    originalSize?: number;
    compressedSize?: number;
    sha256: string;
    createdAt: string;
}
export interface FileIndexEntry {
    filePath: string;
    snapshotId: string;
    sha256: string;
    sizeBytes?: number;
    mtimeMs?: number;
    updatedAt: string;
}
export interface Checkpoint {
    id: string;
    sessionId: string;
    name: string;
    sequenceNum: number;
    createdAt: string;
}
export declare class DatabaseManager {
    private db;
    private dbPath;
    constructor(customDbPath?: string);
    private init;
    close(): void;
    getPath(): string;
    createSession(session: Session): void;
    endSession(sessionId: string, endedAt: string): void;
    getSession(sessionId: string): Session | null;
    getLatestSession(): Session | null;
    createTurn(turn: Turn): void;
    incrementTurnActionCount(turnId: string): void;
    getTurn(turnId: string): Turn | null;
    getLastTurnForSession(sessionId: string): Turn | null;
    getTurnsForSession(sessionId: string): Turn[];
    getLastActionTimestampForSession(sessionId: string): string | null;
    createAction(action: Action): void;
    updateActionResults(actionId: string, success: boolean, resultData?: Record<string, any>, latencyMs?: number, postHash?: string): void;
    updateActionState(actionId: string, state: 'executed' | 'undone' | 'undo_failed', undoneAt?: string, undoResult?: Record<string, any>, undoError?: string): void;
    updateActionTransition(actionId: string, preSnapshotId?: string, postSnapshotId?: string, preHash?: string, postHash?: string): void;
    deleteAction(actionId: string): void;
    decrementTurnActionCount(turnId: string): void;
    getAction(actionId: string): Action | null;
    getActionsForSession(sessionId: string): Action[];
    getActionsForTurn(turnId: string): Action[];
    private mapRowToAction;
    createSnapshot(snapshot: Snapshot): void;
    getSnapshot(snapshotId: string): Snapshot | null;
    updateSnapshotActionId(snapshotId: string, actionId: string): void;
    setFileIndex(entry: FileIndexEntry): void;
    getFileIndex(filePath: string): FileIndexEntry | null;
    deleteFileIndex(filePath: string): void;
    createCheckpoint(checkpoint: Checkpoint): void;
    getCheckpoint(sessionId: string, name: string): Checkpoint | null;
}
