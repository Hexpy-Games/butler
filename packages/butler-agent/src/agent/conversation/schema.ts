export const CONVERSATION_STORE_SCHEMA_VERSION = 3;

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

CREATE TABLE IF NOT EXISTS conversation_turn_outcomes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  request_message_id TEXT,
  public_assistant_message_id TEXT,
  provider_id TEXT,
  model_ref TEXT,
  evidence_refs_json TEXT NOT NULL,
  unresolved_obligations_json TEXT NOT NULL,
  continuation_json TEXT,
  safe_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE,
  FOREIGN KEY (request_message_id) REFERENCES conversation_messages(id) ON DELETE SET NULL,
  FOREIGN KEY (public_assistant_message_id) REFERENCES conversation_messages(id) ON DELETE SET NULL
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

CREATE TABLE IF NOT EXISTS btcc_interruption_receipts (
  interruption_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  diagnostic_code TEXT NOT NULL,
  last_stable_checkpoint_ref TEXT NOT NULL,
  pending_operation_ref TEXT,
  side_effect_state TEXT NOT NULL CHECK (
    side_effect_state IN ('none', 'known_applied', 'known_not_applied', 'indeterminate')
  ),
  resume_predicate_ref TEXT NOT NULL,
  wake_revision_ref TEXT,
  progress_fingerprint TEXT NOT NULL,
  diagnostic_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS btcc_recovery_cases (
  recovery_case_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  interruption_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  diagnostic_code TEXT NOT NULL,
  last_stable_checkpoint_ref TEXT NOT NULL,
  pending_operation_ref TEXT,
  side_effect_state TEXT NOT NULL CHECK (
    side_effect_state IN ('none', 'known_applied', 'known_not_applied', 'indeterminate')
  ),
  owner TEXT NOT NULL CHECK (owner = 'turn_runtime_recovery'),
  resume_predicate_ref TEXT NOT NULL,
  wake_revision_ref TEXT,
  progress_fingerprint TEXT NOT NULL,
  diagnostic_refs_json TEXT NOT NULL,
  public_status_id TEXT NOT NULL,
  available_control_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE,
  FOREIGN KEY (interruption_id) REFERENCES btcc_interruption_receipts(interruption_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS btcc_reporting_receipts (
  reporting_receipt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  result_disposition TEXT NOT NULL CHECK (
    result_disposition IN ('fulfilled', 'partially_fulfilled', 'not_fulfilled')
  ),
  public_message_ref TEXT NOT NULL,
  completion_evidence_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS btcc_cancellation_receipts (
  cancellation_receipt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation > 0),
  checkpoint_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS btcc_turn_states (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'accepted', 'model_deciding', 'announcing_intent', 'executing_tools',
      'observing_tools', 'continuing', 'waiting_user', 'waiting_external',
      'waiting_runtime', 'delivered', 'cancelled'
    )
  ),
  generation INTEGER NOT NULL CHECK (generation > 0),
  last_stable_checkpoint_ref TEXT,
  active_recovery_case_id TEXT,
  active_wait_owner_ref TEXT,
  active_wake_revision_ref TEXT,
  terminal_outcome_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (active_recovery_case_id) REFERENCES btcc_recovery_cases(recovery_case_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'waiting_runtime' AND active_recovery_case_id IS NOT NULL) OR
    (state != 'waiting_runtime' AND active_recovery_case_id IS NULL)
  ),
  CHECK (
    (state IN ('waiting_user', 'waiting_external') AND active_wait_owner_ref IS NOT NULL) OR
    (state NOT IN ('waiting_user', 'waiting_external') AND active_wait_owner_ref IS NULL)
  ),
  CHECK (
    (state = 'waiting_external' AND active_wake_revision_ref IS NOT NULL) OR
    (state != 'waiting_external' AND active_wake_revision_ref IS NULL)
  ),
  CHECK (
    (state IN ('delivered', 'cancelled') AND terminal_outcome_id IS NOT NULL) OR
    (state NOT IN ('delivered', 'cancelled') AND terminal_outcome_id IS NULL)
  )
);

CREATE TRIGGER IF NOT EXISTS btcc_interruption_receipts_immutable_update
BEFORE UPDATE ON btcc_interruption_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_interruption_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_interruption_receipts_immutable_delete
BEFORE DELETE ON btcc_interruption_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_interruption_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_reporting_receipts_immutable_update
BEFORE UPDATE ON btcc_reporting_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_reporting_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_reporting_receipts_immutable_delete
BEFORE DELETE ON btcc_reporting_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_reporting_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_cancellation_receipts_immutable_update
BEFORE UPDATE ON btcc_cancellation_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_cancellation_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_cancellation_receipts_immutable_delete
BEFORE DELETE ON btcc_cancellation_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_cancellation_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_delivered_guard
BEFORE UPDATE OF state ON btcc_turn_states
WHEN NEW.state = 'delivered' AND NOT EXISTS (
  SELECT 1 FROM btcc_reporting_receipts receipt
  WHERE receipt.reporting_receipt_id = NEW.terminal_outcome_id
    AND receipt.turn_id = OLD.turn_id
    AND receipt.attempt_id = OLD.attempt_id
    AND receipt.expected_generation = OLD.generation
)
BEGIN
  SELECT RAISE(ABORT, 'btcc_reporting_receipt_required');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_cancelled_guard
BEFORE UPDATE OF state ON btcc_turn_states
WHEN NEW.state = 'cancelled' AND NOT EXISTS (
  SELECT 1 FROM btcc_cancellation_receipts receipt
  WHERE receipt.cancellation_receipt_id = NEW.terminal_outcome_id
    AND receipt.turn_id = OLD.turn_id
    AND receipt.attempt_id = OLD.attempt_id
    AND receipt.expected_generation = OLD.generation
)
BEGIN
  SELECT RAISE(ABORT, 'btcc_cancellation_receipt_required');
END;

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

CREATE INDEX IF NOT EXISTS conversation_turn_outcomes_session_created_idx
ON conversation_turn_outcomes(session_id, created_at, turn_id);

CREATE INDEX IF NOT EXISTS btcc_turn_states_session_updated_idx
ON btcc_turn_states(session_id, updated_at, turn_id);

CREATE INDEX IF NOT EXISTS btcc_recovery_cases_turn_status_idx
ON btcc_recovery_cases(turn_id, status, created_at);
`;
