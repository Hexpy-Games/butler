export const CONVERSATION_STORE_SCHEMA_VERSION = 1;

export const CONVERSATION_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  project_id TEXT,
  gateway_origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_bindings (
  gateway TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  conversation_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (gateway, external_session_id),
  FOREIGN KEY (conversation_session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  visibility TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  compacted_by_summary_id TEXT,
  source_gateway TEXT,
  source_ref TEXT,
  UNIQUE (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  tool_call_id TEXT,
  parent_tool_call_id TEXT,
  provider_shape TEXT,
  status TEXT NOT NULL,
  UNIQUE (message_id, part_index),
  FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  covers_from_seq INTEGER NOT NULL,
  covers_to_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  model TEXT,
  summary_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_projection_outbox (
  outbox_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id TEXT NOT NULL UNIQUE,
  conversation_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS conversation_turns_session_seq_idx
ON conversation_turns(session_id, seq);

CREATE INDEX IF NOT EXISTS conversation_messages_session_seq_idx
ON conversation_messages(session_id, seq);

CREATE INDEX IF NOT EXISTS conversation_messages_role_created_idx
ON conversation_messages(role, created_at, id);

CREATE INDEX IF NOT EXISTS conversation_messages_session_role_created_idx
ON conversation_messages(session_id, role, created_at, id);

CREATE INDEX IF NOT EXISTS conversation_messages_created_idx
ON conversation_messages(created_at, id);

CREATE INDEX IF NOT EXISTS conversation_parts_message_part_idx
ON conversation_parts(message_id, part_index);

CREATE INDEX IF NOT EXISTS conversation_parts_tool_call_idx
ON conversation_parts(tool_call_id)
WHERE tool_call_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_bindings_gateway_external_idx
ON conversation_bindings(gateway, external_session_id);

CREATE INDEX IF NOT EXISTS conversation_summaries_session_range_idx
ON conversation_summaries(session_id, covers_from_seq, covers_to_seq);
`;
