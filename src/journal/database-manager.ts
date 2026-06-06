import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { MIGRATIONS } from './schema.js';

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
  resultSuccess?: number; // 0 or 1
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

export class DatabaseManager {
  private db: Database.Database;
  private dbPath: string;

  constructor(customDbPath?: string) {
    if (customDbPath) {
      this.dbPath = customDbPath;
    } else {
      const undomcpDir = path.join(os.homedir(), '.undomcp');
      if (!fs.existsSync(undomcpDir)) {
        fs.mkdirSync(undomcpDir, { recursive: true });
      }
      this.dbPath = path.join(undomcpDir, 'journal.db');
    }

    this.db = new Database(this.dbPath);
    this.init();
  }

  private init() {
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

  public close() {
    this.db.close();
  }

  public getPath(): string {
    return this.dbPath;
  }

  // --- Session Methods ---

  public createSession(session: Session): void {
    const query = `
      INSERT INTO sessions (id, started_at, ended_at, working_directory, config_hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    this.db.prepare(query).run(
      session.id,
      session.startedAt,
      session.endedAt || null,
      session.workingDirectory || null,
      session.configHash || null,
      session.metadata ? JSON.stringify(session.metadata) : null
    );
  }

  public endSession(sessionId: string, endedAt: string): void {
    const query = `
      UPDATE sessions
      SET ended_at = ?
      WHERE id = ?
    `;
    this.db.prepare(query).run(endedAt, sessionId);
  }

  public getSession(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at || undefined,
      workingDirectory: row.working_directory || undefined,
      configHash: row.config_hash || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }

  public getLatestSession(): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get() as any;
    if (!row) return null;
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

  public createTurn(turn: Turn): void {
    const query = `
      INSERT INTO turns (id, session_id, turn_num, prompt_text, timestamp, action_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    this.db.prepare(query).run(
      turn.id,
      turn.sessionId,
      turn.turnNum,
      turn.promptText || null,
      turn.timestamp,
      turn.actionCount
    );
  }

  public incrementTurnActionCount(turnId: string): void {
    const query = `
      UPDATE turns
      SET action_count = action_count + 1
      WHERE id = ?
    `;
    this.db.prepare(query).run(turnId);
  }

  public getTurn(turnId: string): Turn | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as any;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      turnNum: row.turn_num,
      promptText: row.prompt_text || undefined,
      timestamp: row.timestamp,
      actionCount: row.action_count
    };
  }

  public getLastTurnForSession(sessionId: string): Turn | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_num DESC LIMIT 1').get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      turnNum: row.turn_num,
      promptText: row.prompt_text || undefined,
      timestamp: row.timestamp,
      actionCount: row.action_count
    };
  }

  public getTurnsForSession(sessionId: string): Turn[] {
    const rows = this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_num ASC').all(sessionId) as any[];
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

  public getLastActionTimestampForSession(sessionId: string): string | null {
    const row = this.db.prepare('SELECT timestamp FROM actions WHERE session_id = ? ORDER BY sequence_num DESC LIMIT 1').get(sessionId) as any;
    return row ? row.timestamp : null;
  }

  public createAction(action: Action): void {
    const query = `
      INSERT INTO actions (
        id, session_id, turn_id, sequence_num, timestamp, action_type,
        tool_name, namespace, parameters, reversibility_class,
        inverse_tool, inverse_params, inverse_source, inverse_confidence,
        pre_snapshot_id, post_snapshot_id, state, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.db.prepare(query).run(
      action.id,
      action.sessionId,
      action.turnId || null,
      action.sequenceNum,
      action.timestamp,
      action.actionType,
      action.toolName || null,
      action.namespace || null,
      action.parameters ? JSON.stringify(action.parameters) : null,
      action.reversibilityClass || null,
      action.inverseTool || null,
      action.inverseParams ? JSON.stringify(action.inverseParams) : null,
      action.inverseSource || null,
      action.inverseConfidence !== undefined ? action.inverseConfidence : null,
      action.preSnapshotId || null,
      action.postSnapshotId || null,
      action.state,
      action.metadata ? JSON.stringify(action.metadata) : null
    );

    if (action.turnId) {
      this.incrementTurnActionCount(action.turnId);
    }
  }

  public updateActionResults(
    actionId: string,
    success: boolean,
    resultData?: Record<string, any>,
    latencyMs?: number,
    postHash?: string
  ): void {
    const query = `
      UPDATE actions
      SET result_success = ?, result_data = ?, result_latency_ms = ?, post_hash = ?
      WHERE id = ?
    `;
    this.db.prepare(query).run(
      success ? 1 : 0,
      resultData ? JSON.stringify(resultData) : null,
      latencyMs !== undefined ? latencyMs : null,
      postHash || null,
      actionId
    );
  }

  public updateActionState(
    actionId: string,
    state: 'executed' | 'undone' | 'undo_failed',
    undoneAt?: string,
    undoResult?: Record<string, any>,
    undoError?: string
  ): void {
    const query = `
      UPDATE actions
      SET state = ?, undone_at = ?, undo_result = ?, undo_error = ?
      WHERE id = ?
    `;
    this.db.prepare(query).run(
      state,
      undoneAt || null,
      undoResult ? JSON.stringify(undoResult) : null,
      undoError || null,
      actionId
    );
  }

  public getAction(actionId: string): Action | null {
    const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as any;
    if (!row) return null;
    return this.mapRowToAction(row);
  }

  public getActionsForSession(sessionId: string): Action[] {
    const rows = this.db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY sequence_num ASC').all(sessionId) as any[];
    return rows.map(row => this.mapRowToAction(row));
  }

  public getActionsForTurn(turnId: string): Action[] {
    const rows = this.db.prepare('SELECT * FROM actions WHERE turn_id = ? ORDER BY sequence_num ASC').all(turnId) as any[];
    return rows.map(row => this.mapRowToAction(row));
  }

  private mapRowToAction(row: any): Action {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id || undefined,
      sequenceNum: row.sequence_num,
      timestamp: row.timestamp,
      actionType: row.action_type as any,
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
      state: row.state as any,
      undoneAt: row.undone_at || undefined,
      undoResult: row.undo_result ? JSON.parse(row.undo_result) : undefined,
      undoError: row.undo_error || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }

  // --- Snapshot Methods ---

  public createSnapshot(snapshot: Snapshot): void {
    const query = `
      INSERT INTO snapshots (
        id, action_id, file_path, content, snapshot_role,
        original_size, compressed_size, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.db.prepare(query).run(
      snapshot.id,
      snapshot.actionId || null,
      snapshot.filePath,
      snapshot.content || null,
      snapshot.snapshotRole,
      snapshot.originalSize || null,
      snapshot.compressedSize || null,
      snapshot.sha256,
      snapshot.createdAt
    );
  }

  public getSnapshot(snapshotId: string): Snapshot | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId) as any;
    if (!row) return null;
    return {
      id: row.id,
      actionId: row.action_id || undefined,
      filePath: row.file_path,
      content: row.content as Buffer || undefined,
      snapshotRole: row.snapshot_role as any,
      originalSize: row.original_size || undefined,
      compressedSize: row.compressed_size || undefined,
      sha256: row.sha256,
      createdAt: row.created_at
    };
  }

  // --- File Index Methods ---

  public setFileIndex(entry: FileIndexEntry): void {
    const query = `
      INSERT INTO file_index (file_path, snapshot_id, sha256, size_bytes, mtime_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        snapshot_id = excluded.snapshot_id,
        sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at
    `;
    this.db.prepare(query).run(
      entry.filePath,
      entry.snapshotId,
      entry.sha256,
      entry.sizeBytes !== undefined ? entry.sizeBytes : null,
      entry.mtimeMs !== undefined ? entry.mtimeMs : null,
      entry.updatedAt
    );
  }

  public getFileIndex(filePath: string): FileIndexEntry | null {
    const row = this.db.prepare('SELECT * FROM file_index WHERE file_path = ?').get(filePath) as any;
    if (!row) return null;
    return {
      filePath: row.file_path,
      snapshotId: row.snapshot_id,
      sha256: row.sha256,
      sizeBytes: row.size_bytes || undefined,
      mtimeMs: row.mtime_ms || undefined,
      updatedAt: row.updated_at
    };
  }

  public deleteFileIndex(filePath: string): void {
    const query = 'DELETE FROM file_index WHERE file_path = ?';
    this.db.prepare(query).run(filePath);
  }

  // --- Checkpoint Methods ---

  public createCheckpoint(checkpoint: Checkpoint): void {
    const query = `
      INSERT INTO checkpoints (id, session_id, name, sequence_num, created_at)
      VALUES (?, ?, ?, ?, ?)
    `;
    this.db.prepare(query).run(
      checkpoint.id,
      checkpoint.sessionId,
      checkpoint.name,
      checkpoint.sequenceNum,
      checkpoint.createdAt
    );
  }

  public getCheckpoint(sessionId: string, name: string): Checkpoint | null {
    const query = 'SELECT * FROM checkpoints WHERE session_id = ? AND name = ?';
    const row = this.db.prepare(query).get(sessionId, name) as any;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      sequenceNum: row.sequence_num,
      createdAt: row.created_at
    };
  }
}
