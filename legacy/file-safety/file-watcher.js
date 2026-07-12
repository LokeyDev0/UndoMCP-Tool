import * as path from 'path';
import * as fs from 'fs';
import chokidar from 'chokidar';
/**
 * Converts a .gitignore glob pattern into a regular expression.
 */
export function globToRegex(glob) {
    let sanitized = glob.trim().replace(/\\/g, '/');
    // Strip trailing slash if any (we'll match it and any contents recursively)
    const hasTrailingSlash = sanitized.endsWith('/');
    if (hasTrailingSlash) {
        sanitized = sanitized.slice(0, -1);
    }
    const isRootRelative = sanitized.startsWith('/');
    if (isRootRelative) {
        sanitized = sanitized.slice(1);
    }
    let regexStr = '';
    let i = 0;
    while (i < sanitized.length) {
        const char = sanitized[i];
        if (char === '*') {
            if (sanitized[i + 1] === '*') {
                regexStr += '.*';
                i += 2;
                if (sanitized[i] === '/') {
                    regexStr += '\/?';
                    i++;
                }
            }
            else {
                regexStr += '[^/]*';
                i++;
            }
        }
        else if (char === '?') {
            regexStr += '[^/]';
            i++;
        }
        else if (char === '.') {
            regexStr += '\\.';
            i++;
        }
        else if (char === '/') {
            regexStr += '\\/';
            i++;
        }
        else if ('+()[]{}|^$\\'.includes(char)) {
            regexStr += '\\' + char;
            i++;
        }
        else {
            regexStr += char;
            i++;
        }
    }
    if (isRootRelative) {
        return new RegExp('^' + regexStr + '($|\\/.*)');
    }
    else {
        return new RegExp('(^|\\/)' + regexStr + '($|\\/.*)');
    }
}
export class WorkspaceFileWatcher {
    workspacePath;
    onEvents;
    debounceMs;
    watcher = null;
    gitignoreRules = [];
    eventBuffer = new Map();
    debounceTimer = null;
    constructor(options) {
        this.workspacePath = path.resolve(options.workspacePath);
        this.onEvents = options.onEvents;
        this.debounceMs = options.debounceMs ?? 100;
        this.loadGitignore();
    }
    /**
     * Loads and parses the root-level .gitignore file.
     */
    loadGitignore() {
        const gitignorePath = path.join(this.workspacePath, '.gitignore');
        if (!fs.existsSync(gitignorePath))
            return;
        try {
            const content = fs.readFileSync(gitignorePath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                if (trimmed.startsWith('!'))
                    continue; // Skip negative rules for simplicity
                try {
                    this.gitignoreRules.push(globToRegex(trimmed));
                }
                catch (err) {
                    console.error(`[undomcp] Failed to compile gitignore rule "${trimmed}":`, err);
                }
            }
        }
        catch (err) {
            console.error(`[undomcp] Error reading .gitignore: ${err.message}`);
        }
    }
    /**
     * Helper to check if a file path is ignored.
     */
    isIgnored(filePath) {
        const absolutePath = path.resolve(filePath);
        const relativePath = path.relative(this.workspacePath, absolutePath).replace(/\\/g, '/');
        // Always ignore .git, node_modules, and .undomcp directories
        if (relativePath === '.git' || relativePath.startsWith('.git/') ||
            relativePath === 'node_modules' || relativePath.startsWith('node_modules/') ||
            relativePath === '.undomcp' || relativePath.startsWith('.undomcp/')) {
            return true;
        }
        // Run against compiled gitignore rules
        for (const rule of this.gitignoreRules) {
            if (rule.test(relativePath)) {
                return true;
            }
        }
        return false;
    }
    /**
     * Starts the file watcher. Resolves when the watcher is fully ready.
     */
    start() {
        if (this.watcher)
            return Promise.resolve();
        return new Promise((resolve) => {
            this.watcher = chokidar.watch(this.workspacePath, {
                ignored: (filePath) => this.isIgnored(filePath),
                persistent: true,
                ignoreInitial: true, // Only watch post-start modifications
                awaitWriteFinish: {
                    stabilityThreshold: 50,
                    pollInterval: 10
                }
            });
            this.watcher.on('ready', () => {
                resolve();
            });
            this.watcher
                .on('add', (filePath) => this.handleFsEvent(filePath, 'create'))
                .on('change', (filePath) => this.handleFsEvent(filePath, 'modify'))
                .on('unlink', (filePath) => this.handleFsEvent(filePath, 'delete'));
        });
    }
    /**
     * Stops the file watcher.
     */
    stop() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.eventBuffer.clear();
        if (!this.watcher) {
            return Promise.resolve();
        }
        const tempWatcher = this.watcher;
        this.watcher = null;
        return tempWatcher.close();
    }
    /**
     * Buffers, collapses, and debounces file events.
     */
    handleFsEvent(filePath, type) {
        const absolutePath = path.resolve(filePath);
        const existing = this.eventBuffer.get(absolutePath);
        if (!existing) {
            this.eventBuffer.set(absolutePath, {
                path: absolutePath,
                type,
                timestamp: new Date().toISOString()
            });
        }
        else {
            // Event Collapsing Logic
            if (existing.type === 'create') {
                if (type === 'delete') {
                    // File was created and then deleted within the debounce window -> discard
                    this.eventBuffer.delete(absolutePath);
                }
                else {
                    // Created and then modified -> still 'create'
                    existing.timestamp = new Date().toISOString();
                }
            }
            else if (existing.type === 'modify') {
                if (type === 'delete') {
                    existing.type = 'delete';
                }
                existing.timestamp = new Date().toISOString();
            }
            else if (existing.type === 'delete') {
                if (type === 'create' || type === 'modify') {
                    // Deleted and then recreated -> treat as modify
                    existing.type = 'modify';
                }
                existing.timestamp = new Date().toISOString();
            }
        }
        // Reset debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.flushEvents();
        }, this.debounceMs);
    }
    /**
     * Flushes the buffered events and triggers the callback.
     */
    async flushEvents() {
        const events = Array.from(this.eventBuffer.values());
        this.eventBuffer.clear();
        this.debounceTimer = null;
        if (events.length > 0) {
            try {
                await this.onEvents(events);
            }
            catch (err) {
                console.error(`[undomcp] Error in file watcher onEvents callback: ${err.message}`);
            }
        }
    }
}
