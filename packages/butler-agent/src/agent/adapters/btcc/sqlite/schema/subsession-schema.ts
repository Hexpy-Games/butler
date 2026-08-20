export const BTCC_SUBSESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_session_relations (
  relation_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_turn_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL UNIQUE,
  anchor_message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  safe_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS btcc_subsession_delegations (
  delegation_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE,
  child_turn_id TEXT NOT NULL UNIQUE,
  root_work_id TEXT NOT NULL UNIQUE,
  packet_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);

CREATE TABLE IF NOT EXISTS btcc_steward_results (
  result_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  child_turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'blocked', 'failed', 'cancelled')),
  code TEXT CHECK (code IS NULL OR code IN (
    'delegation_context_incomplete',
    'steward_execution_failed', 'steward_cancelled'
  )),
  summary TEXT NOT NULL,
  acceptance_evidence_json TEXT NOT NULL,
  changed_artifacts_json TEXT NOT NULL,
  commits_json TEXT NOT NULL DEFAULT '[]',
  tests_json TEXT NOT NULL DEFAULT '[]',
  remaining_risks_json TEXT NOT NULL DEFAULT '[]',
  follow_up_recommendations_json TEXT NOT NULL DEFAULT '[]',
  detail_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);

CREATE TABLE IF NOT EXISTS btcc_subsession_outbox (
  outbox_id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL UNIQUE,
  result_id TEXT NOT NULL UNIQUE,
  parent_session_id TEXT NOT NULL,
  parent_turn_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY(relation_id) REFERENCES btcc_session_relations(relation_id)
);
`;
