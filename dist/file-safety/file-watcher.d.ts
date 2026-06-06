export interface FileEvent {
    path: string;
    type: 'create' | 'modify' | 'delete';
    timestamp: string;
}
export interface WorkspaceFileWatcherOptions {
    workspacePath: string;
    onEvents: (events: FileEvent[]) => void | Promise<void>;
    debounceMs?: number;
}
/**
 * Converts a .gitignore glob pattern into a regular expression.
 */
export declare function globToRegex(glob: string): RegExp;
export declare class WorkspaceFileWatcher {
    private workspacePath;
    private onEvents;
    private debounceMs;
    private watcher;
    private gitignoreRules;
    private eventBuffer;
    private debounceTimer;
    constructor(options: WorkspaceFileWatcherOptions);
    /**
     * Loads and parses the root-level .gitignore file.
     */
    private loadGitignore;
    /**
     * Helper to check if a file path is ignored.
     */
    isIgnored(filePath: string): boolean;
    /**
     * Starts the file watcher. Resolves when the watcher is fully ready.
     */
    start(): Promise<void>;
    /**
     * Stops the file watcher.
     */
    stop(): Promise<void>;
    /**
     * Buffers, collapses, and debounces file events.
     */
    private handleFsEvent;
    /**
     * Flushes the buffered events and triggers the callback.
     */
    private flushEvents;
}
