export const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    working_directory TEXT,
    config_hash TEXT,
    metadata TEXT  -- JSON
  );
`;

export const CREATE_TURNS_TABLE = `
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_num INTEGER NOT NULL,
    prompt_text TEXT,
    timestamp TEXT NOT NULL,
    action_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, turn_num)
  );
`;

export const CREATE_ACTIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
    sequence_num INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    action_type TEXT NOT NULL,  -- 'mcp_call', 'file_change', 'checkpoint'
    tool_name TEXT,
    namespace TEXT,
    parameters TEXT,  -- JSON
    result_success INTEGER,
    result_data TEXT,  -- JSON
    result_latency_ms INTEGER,
    pre_hash TEXT,
    post_hash TEXT,
    reversibility_class TEXT,  -- 'A', 'B', 'C', 'D'
    inverse_tool TEXT,
    inverse_params TEXT,  -- JSON
    inverse_source TEXT,  -- 'explicit_contract', 'filesystem_shadow', 'heuristic', 'llm_suggestion'
    inverse_confidence REAL,
    pre_snapshot_id TEXT,
    post_snapshot_id TEXT,
    state TEXT NOT NULL DEFAULT 'executed',  -- 'executed', 'undone', 'undo_failed'
    undone_at TEXT,
    undo_result TEXT,  -- JSON
    undo_error TEXT,
    metadata TEXT,  -- JSON
    UNIQUE(session_id, sequence_num)
  );
`;

export const CREATE_SNAPSHOTS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    snapshot_role TEXT NOT NULL,  -- 'pre', 'post', 'baseline'
    content BLOB NOT NULL,       -- zlib-compressed file content
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id, sequence_num);',
  'CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp);',
  'CREATE INDEX IF NOT EXISTS idx_actions_state ON actions(state);',
  'CREATE INDEX IF NOT EXISTS idx_actions_turn ON actions(turn_id);',
  'CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_num);',
  'CREATE INDEX IF NOT EXISTS idx_sessions_working_dir ON sessions(working_directory);',
  'CREATE INDEX IF NOT EXISTS idx_snapshots_action ON snapshots(action_id);',
  'CREATE INDEX IF NOT EXISTS idx_snapshots_path ON snapshots(file_path);'
];

export const MIGRATIONS = [
  CREATE_SESSIONS_TABLE,
  CREATE_TURNS_TABLE,
  CREATE_ACTIONS_TABLE,
  CREATE_SNAPSHOTS_TABLE,
  ...CREATE_INDEXES
];
