import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { MIGRATIONS } from './schema.js';
export class DatabaseManager {
    db;
    dbPath;
    actionCountSinceLastCheck = 0;
    static MAX_DB_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
    static TARGET_DB_SIZE_BYTES = 45 * 1024 * 1024; // 45MB headroom
    static CHECK_INTERVAL = 50; // check every 50 actions
    constructor(customDbPath) {
        if (customDbPath) {
            this.dbPath = customDbPath;
        }
        else {
            const undomcpDir = path.join(os.homedir(), '.undomcp');
            if (!fs.existsSync(undomcpDir)) {
                fs.mkdirSync(undomcpDir, { recursive: true });
            }
            this.dbPath = path.join(undomcpDir, 'journal.db');
        }
        this.db = new Database(this.dbPath);
        this.init();
    }
    init() {
        // Enable WAL mode for concurrent operations and performance
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        // Run migrations inside a transaction
        this.db.transaction(() => {
            for (const migration of MIGRATIONS) {
                this.db.prepare(migration).run();
            }
        })();
    }
    close() {
        this.db.close();
    }
    getPath() {
        return this.dbPath;
    }
    normalizePath(p) {
        // Resolve to absolute, lowercase, forward slashes, no trailing slash
        // Works on Windows, macOS, and Linux
        return path.resolve(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    }
    // --- Session Methods ---
    createSession(session) {
        const normalizedWd = session.workingDirectory
            ? this.normalizePath(session.workingDirectory)
            : null;
        const query = `
      INSERT INTO sessions (id, started_at, ended_at, working_directory, config_hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
        this.db.prepare(query).run(session.id, session.startedAt, session.endedAt || null, normalizedWd, session.configHash || null, session.metadata ? JSON.stringify(session.metadata) : null);
    }
    endSession(sessionId, endedAt) {
        const query = `
      UPDATE sessions
      SET ended_at = ?
      WHERE id = ?
    `;
        this.db.prepare(query).run(endedAt, sessionId);
    }
    getSession(sessionId) {
        const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
        if (!row)
            return null;
        return {
            id: row.id,
            startedAt: row.started_at,
            endedAt: row.ended_at || undefined,
            workingDirectory: row.working_directory || undefined,
            configHash: row.config_hash || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        };
    }
    getLatestSession() {
        const row = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get();
        if (!row)
            return null;
        return {
            id: row.id,
            startedAt: row.started_at,
            endedAt: row.ended_at || undefined,
            workingDirectory: row.working_directory || undefined,
            configHash: row.config_hash || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        };
    }
    // --- Turn Methods ---
    createTurn(turn) {
        const query = `
      INSERT INTO turns (id, session_id, turn_num, prompt_text, timestamp, action_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
        this.db.prepare(query).run(turn.id, turn.sessionId, turn.turnNum, turn.promptText || null, turn.timestamp, turn.actionCount);
    }
    incrementTurnActionCount(turnId) {
        const query = `
      UPDATE turns
      SET action_count = action_count + 1
      WHERE id = ?
    `;
        this.db.prepare(query).run(turnId);
    }
    getTurn(turnId) {
        const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
        if (!row)
            return null;
        return {
            id: row.id,
            sessionId: row.session_id,
            turnNum: row.turn_num,
            promptText: row.prompt_text || undefined,
            timestamp: row.timestamp,
            actionCount: row.action_count
        };
    }
    getLastTurnForSession(sessionId) {
        const row = this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_num DESC LIMIT 1').get(sessionId);
        if (!row)
            return null;
        return {
            id: row.id,
            sessionId: row.session_id,
            turnNum: row.turn_num,
            promptText: row.prompt_text || undefined,
            timestamp: row.timestamp,
            actionCount: row.action_count
        };
    }
    getTurnsForSession(sessionId) {
        const rows = this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_num ASC').all(sessionId);
        return rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            turnNum: row.turn_num,
            promptText: row.prompt_text || undefined,
            timestamp: row.timestamp,
            actionCount: row.action_count
        }));
    }
    // --- Action Methods ---
    getLastActionTimestampForSession(sessionId) {
        const row = this.db.prepare('SELECT timestamp FROM actions WHERE session_id = ? ORDER BY sequence_num DESC LIMIT 1').get(sessionId);
        return row ? row.timestamp : null;
    }
    createAction(action) {
        const query = `
      INSERT INTO actions (
        id, session_id, turn_id, sequence_num, timestamp, action_type,
        tool_name, namespace, parameters, reversibility_class,
        inverse_tool, inverse_params, inverse_source, inverse_confidence,
        pre_snapshot_id, post_snapshot_id, state, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
        this.db.prepare(query).run(action.id, action.sessionId, action.turnId || null, action.sequenceNum, action.timestamp, action.actionType, action.toolName || null, action.namespace || null, action.parameters ? JSON.stringify(action.parameters) : null, action.reversibilityClass || null, action.inverseTool || null, action.inverseParams ? JSON.stringify(action.inverseParams) : null, action.inverseSource || null, action.inverseConfidence !== undefined ? action.inverseConfidence : null, action.preSnapshotId || null, action.postSnapshotId || null, action.state, action.metadata ? JSON.stringify(action.metadata) : null);
        if (action.turnId) {
            this.incrementTurnActionCount(action.turnId);
        }
        this.enforceSizeLimit();
    }
    updateActionResults(actionId, success, resultData, latencyMs, postHash) {
        const query = `
      UPDATE actions
      SET result_success = ?, result_data = ?, result_latency_ms = ?, post_hash = ?
      WHERE id = ?
    `;
        this.db.prepare(query).run(success ? 1 : 0, resultData ? JSON.stringify(resultData) : null, latencyMs !== undefined ? latencyMs : null, postHash || null, actionId);
    }
    updateActionState(actionId, state, undoneAt, undoResult, undoError) {
        const query = `
      UPDATE actions
      SET state = ?, undone_at = ?, undo_result = ?, undo_error = ?
      WHERE id = ?
    `;
        this.db.prepare(query).run(state, undoneAt || null, undoResult ? JSON.stringify(undoResult) : null, undoError || null, actionId);
    }
    updateActionTransition(actionId, preSnapshotId, postSnapshotId, preHash, postHash) {
        const query = `
      UPDATE actions
      SET pre_snapshot_id = ?, post_snapshot_id = ?, pre_hash = ?, post_hash = ?
      WHERE id = ?
    `;
        this.db.prepare(query).run(preSnapshotId || null, postSnapshotId || null, preHash || null, postHash || null, actionId);
    }
    deleteAction(actionId) {
        const action = this.getAction(actionId);
        this.db.prepare('DELETE FROM actions WHERE id = ?').run(actionId);
        if (action && action.turnId) {
            this.decrementTurnActionCount(action.turnId);
        }
    }
    decrementTurnActionCount(turnId) {
        const query = `
      UPDATE turns
      SET action_count = MAX(0, action_count - 1)
      WHERE id = ?
    `;
        this.db.prepare(query).run(turnId);
    }
    getAction(actionId) {
        const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
        if (!row)
            return null;
        return this.mapRowToAction(row);
    }
    getActionsForSession(sessionId) {
        const rows = this.db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY sequence_num ASC').all(sessionId);
        return rows.map(row => this.mapRowToAction(row));
    }
    getActionsForTurn(turnId) {
        const rows = this.db.prepare('SELECT * FROM actions WHERE turn_id = ? ORDER BY sequence_num ASC').all(turnId);
        return rows.map(row => this.mapRowToAction(row));
    }
    mapRowToAction(row) {
        return {
            id: row.id,
            sessionId: row.session_id,
            turnId: row.turn_id || undefined,
            sequenceNum: row.sequence_num,
            timestamp: row.timestamp,
            actionType: row.action_type,
            toolName: row.tool_name || undefined,
            namespace: row.namespace || undefined,
            parameters: row.parameters ? JSON.parse(row.parameters) : undefined,
            resultSuccess: row.result_success !== null ? row.result_success : undefined,
            resultData: row.result_data ? JSON.parse(row.result_data) : undefined,
            resultLatencyMs: row.result_latency_ms !== null ? row.result_latency_ms : undefined,
            preHash: row.pre_hash || undefined,
            postHash: row.post_hash || undefined,
            reversibilityClass: row.reversibility_class || undefined,
            inverseTool: row.inverse_tool || undefined,
            inverseParams: row.inverse_params ? JSON.parse(row.inverse_params) : undefined,
            inverseSource: row.inverse_source || undefined,
            inverseConfidence: row.inverse_confidence !== null ? row.inverse_confidence : undefined,
            preSnapshotId: row.pre_snapshot_id || undefined,
            postSnapshotId: row.post_snapshot_id || undefined,
            state: row.state,
            undoneAt: row.undone_at || undefined,
            undoResult: row.undo_result ? JSON.parse(row.undo_result) : undefined,
            undoError: row.undo_error || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        };
    }
    // --- Snapshot Methods ---
    createSnapshot(snapshot) {
        const query = `
      INSERT INTO snapshots (id, action_id, file_path, snapshot_role, content, original_size, compressed_size, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
        this.db.prepare(query).run(snapshot.id, snapshot.actionId || null, snapshot.filePath, snapshot.snapshotRole, snapshot.content, snapshot.originalSize, snapshot.compressedSize, snapshot.sha256, snapshot.createdAt);
    }
    getSnapshot(snapshotId) {
        const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
        if (!row)
            return null;
        return {
            id: row.id,
            actionId: row.action_id || undefined,
            filePath: row.file_path,
            snapshotRole: row.snapshot_role,
            content: row.content,
            originalSize: row.original_size,
            compressedSize: row.compressed_size,
            sha256: row.sha256,
            createdAt: row.created_at
        };
    }
    updateSnapshotActionId(snapshotId, actionId) {
        this.db.prepare('UPDATE snapshots SET action_id = ? WHERE id = ?').run(actionId, snapshotId);
    }
    deleteSnapshot(snapshotId) {
        this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
    }
    // --- Project-Scoped Query Methods ---
    getRecentActionsForProject(workingDirectory, limit = 10) {
        const normalized = this.normalizePath(workingDirectory);
        // Use LIKE prefix match and also normalize stored paths at query time
        // to handle old sessions that stored unnormalized paths or slightly different
        // directory names (e.g., "Antigravity IDE" vs "Antigravity").
        const query = `
      SELECT a.* FROM actions a
      INNER JOIN sessions s ON a.session_id = s.id
      WHERE (LOWER(REPLACE(s.working_directory, '\\', '/')) = ?
             OR LOWER(REPLACE(s.working_directory, '\\', '/')) LIKE ? || '%')
        AND a.action_type = 'mcp_call'
        AND a.state = 'executed'
      ORDER BY a.timestamp DESC, a.sequence_num DESC
      LIMIT ?
    `;
        const rows = this.db.prepare(query).all(normalized, normalized, limit);
        // Reverse so result is oldest-first (for correct N-to-1 numbering in skill)
        return rows.reverse().map(row => this.mapRowToAction(row));
    }
    getSessionsForProject(workingDirectory) {
        const normalized = this.normalizePath(workingDirectory);
        const rows = this.db.prepare('SELECT * FROM sessions WHERE working_directory = ? ORDER BY started_at ASC').all(normalized);
        return rows.map(row => ({
            id: row.id,
            startedAt: row.started_at,
            endedAt: row.ended_at || undefined,
            workingDirectory: row.working_directory || undefined,
            configHash: row.config_hash || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined
        }));
    }
    // --- Storage Limit Enforcement ---
    enforceSizeLimit() {
        this.actionCountSinceLastCheck++;
        if (this.actionCountSinceLastCheck < DatabaseManager.CHECK_INTERVAL)
            return;
        this.actionCountSinceLastCheck = 0;
        let stats;
        try {
            stats = fs.statSync(this.dbPath);
        }
        catch {
            return; // Can't stat, skip check
        }
        if (stats.size <= DatabaseManager.MAX_DB_SIZE_BYTES)
            return;
        // Delete oldest sessions (cascades to turns + actions via ON DELETE CASCADE)
        while (true) {
            const oldest = this.db.prepare('SELECT id FROM sessions ORDER BY started_at ASC LIMIT 1').get();
            if (!oldest)
                break;
            this.db.prepare('DELETE FROM sessions WHERE id = ?').run(oldest.id);
            // Checkpoint WAL and re-check size
            try {
                this.db.pragma('wal_checkpoint(TRUNCATE)');
            }
            catch {
                // Ignore checkpoint errors
            }
            try {
                const newStats = fs.statSync(this.dbPath);
                if (newStats.size <= DatabaseManager.TARGET_DB_SIZE_BYTES)
                    break;
            }
            catch {
                break;
            }
        }
        // Reclaim space
        try {
            this.db.exec('VACUUM');
        }
        catch {
            // Ignore vacuum errors
        }
    }
}
