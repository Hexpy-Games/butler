export const CONVERSATION_STORE_SCHEMA_VERSION = 4;

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
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN (
      'active', 'waiting_user', 'waiting_external', 'waiting_runtime',
      'scheduled_continuation', 'cancelled', 'delivered'
    )
  ),
  current_phase TEXT NOT NULL DEFAULT 'conception' CHECK (
    current_phase IN (
      'conception', 'planning', 'execution', 'review', 'consolidation', 'reporting'
    )
  ),
  phase_generation INTEGER NOT NULL DEFAULT 1 CHECK (phase_generation > 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  project_policy_json TEXT NOT NULL DEFAULT '{"kind":"unbound"}'
    CHECK (json_valid(project_policy_json)),
  tracking_policy_candidate_json TEXT CHECK (
    tracking_policy_candidate_json IS NULL OR json_valid(tracking_policy_candidate_json)
  ),
  tracking_policy_json TEXT CHECK (
    tracking_policy_json IS NULL OR json_valid(tracking_policy_json)
  ),
  accepted_controls_ref TEXT NOT NULL DEFAULT '',
  goal_contract_ref TEXT,
  active_conception_checkpoint_ref TEXT,
  active_planning_checkpoint_ref TEXT,
  active_execution_checkpoint_ref TEXT,
  active_review_checkpoint_ref TEXT,
  active_consolidation_checkpoint_ref TEXT,
  active_reporting_checkpoint_ref TEXT,
  active_consolidation_target_ref TEXT,
  active_final_dossier_ref TEXT,
  active_tracking_attempt_ref TEXT,
  active_execution_operation_ref TEXT,
  active_review_target_ref TEXT,
  open_tool_call_ref TEXT,
  plan_revision_ref TEXT,
  active_tracking_work_ref TEXT,
  active_task_ref TEXT,
  active_return_ticket_ref TEXT,
  pending_closeout_ref TEXT,
  active_continuation_owner_ref TEXT,
  accepted_receipt_refs_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(accepted_receipt_refs_json)),
  invalidated_receipt_refs_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(invalidated_receipt_refs_json)),
  last_stable_input_fingerprint TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS btcc_conception_checkpoints (
  checkpoint_ref TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  phase_generation INTEGER NOT NULL CHECK (phase_generation > 0),
  round_index INTEGER NOT NULL CHECK (round_index >= 0),
  working_goal_draft_json TEXT,
  open_evidence_needs_json TEXT NOT NULL,
  observation_refs_json TEXT NOT NULL,
  pending_tool_call_ref TEXT,
  last_input_fingerprint TEXT NOT NULL,
  public_progress_ref TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'superseded', 'finalized', 'aborted')
  ),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES btcc_turn_states(turn_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS btcc_goal_contracts (
  goal_contract_ref TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  conception_model_call_id TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES btcc_turn_states(turn_id) ON DELETE CASCADE,
  UNIQUE (turn_id, attempt_id, revision)
);

CREATE TABLE IF NOT EXISTS btcc_phase_artifacts (
  artifact_ref TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'conception', 'planning', 'execution', 'review', 'consolidation', 'reporting'
    )
  ),
  phase_generation INTEGER NOT NULL CHECK (phase_generation > 0),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'accepted_controls', 'structural_project_policy', 'tracking_policy_candidate',
    'opening_decision', 'continuity_update', 'user_blocker', 'planning_input',
    'planning_checkpoint', 'planning_validation_gap', 'task_graph',
    'tracking_materialization', 'execution_input', 'execution_checkpoint',
    'execution_operation', 'execution_candidate', 'review_input',
    'review_checkpoint', 'review_candidate', 'review_verdict_frontier',
    'consolidation_input', 'consolidation_checkpoint', 'consolidation_candidate',
    'consolidation_finding_frontier', 'final_dossier', 'reporting_input',
    'reporting_checkpoint', 'report_candidate', 'report_validation_receipt',
    'report_guard_candidate', 'report_guard_receipt', 'tracking_closeout',
    'return_ticket', 'public_progress'
  )),
  artifact_schema_version TEXT NOT NULL,
  task_ref TEXT,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES btcc_turn_states(turn_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS btcc_phase_receipts (
  receipt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'conception', 'planning', 'execution', 'review', 'consolidation', 'reporting'
    )
  ),
  phase_generation INTEGER NOT NULL CHECK (phase_generation > 0),
  task_ref TEXT,
  input_fingerprint TEXT NOT NULL,
  phase_prompt_id TEXT NOT NULL,
  phase_prompt_version INTEGER NOT NULL CHECK (phase_prompt_version > 0),
  phase_prompt_hash TEXT NOT NULL,
  output_artifact_refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  dependency_receipt_refs_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'passed'),
  next_state TEXT NOT NULL CHECK (
    next_state IN (
      'conception', 'planning', 'execution', 'review', 'consolidation', 'reporting',
      'waiting_user', 'waiting_external', 'waiting_runtime',
      'scheduled_continuation', 'kernel_delivery'
    )
  ),
  payload_json TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES btcc_turn_states(turn_id) ON DELETE CASCADE
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

CREATE TRIGGER IF NOT EXISTS btcc_conception_checkpoints_immutable_update
BEFORE UPDATE ON btcc_conception_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'btcc_conception_checkpoint_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_conception_checkpoints_immutable_delete
BEFORE DELETE ON btcc_conception_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'btcc_conception_checkpoint_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_goal_contracts_immutable_update
BEFORE UPDATE ON btcc_goal_contracts
BEGIN
  SELECT RAISE(ABORT, 'btcc_goal_contract_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_goal_contracts_immutable_delete
BEFORE DELETE ON btcc_goal_contracts
BEGIN
  SELECT RAISE(ABORT, 'btcc_goal_contract_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_phase_artifacts_immutable_update
BEFORE UPDATE ON btcc_phase_artifacts
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_artifact_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_phase_artifacts_immutable_delete
BEFORE DELETE ON btcc_phase_artifacts
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_artifact_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_phase_receipts_immutable_update
BEFORE UPDATE ON btcc_phase_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_receipt_immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_phase_receipts_immutable_delete
BEFORE DELETE ON btcc_phase_receipts
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_receipt_immutable');
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

CREATE INDEX IF NOT EXISTS btcc_phase_artifacts_turn_phase_idx
ON btcc_phase_artifacts(turn_id, phase, phase_generation, created_at);

CREATE INDEX IF NOT EXISTS btcc_phase_receipts_turn_phase_idx
ON btcc_phase_receipts(turn_id, phase, phase_generation, created_at);
`;

export const CONVERSATION_STORE_POST_MIGRATION_SQL = `
CREATE TRIGGER IF NOT EXISTS btcc_turn_states_lifecycle_insert_guard
BEFORE INSERT ON btcc_turn_states
WHEN NEW.current_phase NOT IN (
  'conception', 'planning', 'execution', 'review', 'consolidation', 'reporting'
) OR NEW.phase_generation <= 0 OR NEW.row_version <= 0 OR NOT (
  (NEW.lifecycle_status = 'active' AND NEW.state IN (
    'accepted', 'model_deciding', 'announcing_intent', 'executing_tools',
    'observing_tools', 'continuing'
  )) OR
  (NEW.lifecycle_status = 'scheduled_continuation' AND NEW.state = 'continuing') OR
  (NEW.lifecycle_status = 'waiting_user' AND NEW.state = 'waiting_user') OR
  (NEW.lifecycle_status = 'waiting_external' AND NEW.state = 'waiting_external') OR
  (NEW.lifecycle_status = 'waiting_runtime' AND NEW.state = 'waiting_runtime') OR
  (NEW.lifecycle_status = 'delivered' AND NEW.state = 'delivered') OR
  (NEW.lifecycle_status = 'cancelled' AND NEW.state = 'cancelled')
)
BEGIN
  SELECT RAISE(ABORT, 'btcc_turn_lifecycle_state_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_lifecycle_update_guard
BEFORE UPDATE OF state, lifecycle_status ON btcc_turn_states
WHEN NEW.state NOT IN ('delivered', 'cancelled') AND NOT (
  (NEW.lifecycle_status = 'active' AND NEW.state IN (
    'accepted', 'model_deciding', 'announcing_intent', 'executing_tools',
    'observing_tools', 'continuing'
  )) OR
  (NEW.lifecycle_status = 'scheduled_continuation' AND NEW.state = 'continuing') OR
  (NEW.lifecycle_status = 'waiting_user' AND NEW.state = 'waiting_user') OR
  (NEW.lifecycle_status = 'waiting_external' AND NEW.state = 'waiting_external') OR
  (NEW.lifecycle_status = 'waiting_runtime' AND NEW.state = 'waiting_runtime') OR
  (NEW.lifecycle_status = 'delivered' AND NEW.state = 'delivered') OR
  (NEW.lifecycle_status = 'cancelled' AND NEW.state = 'cancelled')
)
BEGIN
  SELECT RAISE(ABORT, 'btcc_turn_lifecycle_state_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_reporting_lifecycle_guard
BEFORE UPDATE OF state, lifecycle_status ON btcc_turn_states
WHEN NEW.state = 'delivered' AND NEW.lifecycle_status != 'delivered'
BEGIN
  SELECT RAISE(ABORT, 'btcc_reporting_receipt_required');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_cancellation_lifecycle_guard
BEFORE UPDATE OF state, lifecycle_status ON btcc_turn_states
WHEN NEW.state = 'cancelled' AND NEW.lifecycle_status != 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'btcc_cancellation_receipt_required');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_phase_value_guard
BEFORE UPDATE OF current_phase, lifecycle_status ON btcc_turn_states
WHEN NEW.current_phase NOT IN (
  'conception', 'planning', 'execution', 'review', 'consolidation', 'reporting'
) OR NEW.lifecycle_status NOT IN (
  'active', 'waiting_user', 'waiting_external', 'waiting_runtime',
  'scheduled_continuation', 'cancelled', 'delivered'
) OR NEW.phase_generation <= 0 OR NEW.row_version <= 0
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_state_value_invalid');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_receipt_refs_guard
BEFORE UPDATE OF current_phase, phase_generation,
  accepted_receipt_refs_json, invalidated_receipt_refs_json ON btcc_turn_states
WHEN NOT json_valid(NEW.accepted_receipt_refs_json)
  OR NOT json_valid(NEW.invalidated_receipt_refs_json)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.accepted_receipt_refs_json) accepted
    LEFT JOIN btcc_phase_receipts receipt ON receipt.receipt_id = accepted.value
    WHERE receipt.receipt_id IS NULL
      OR receipt.turn_id != NEW.turn_id
      OR receipt.attempt_id != NEW.attempt_id
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.invalidated_receipt_refs_json) invalidated
    LEFT JOIN btcc_phase_receipts receipt ON receipt.receipt_id = invalidated.value
    WHERE receipt.receipt_id IS NULL
      OR receipt.turn_id != NEW.turn_id
      OR receipt.attempt_id != NEW.attempt_id
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.accepted_receipt_refs_json) accepted
    JOIN json_each(NEW.invalidated_receipt_refs_json) invalidated
      ON invalidated.value = accepted.value
  )
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_receipt_refs_invalid');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_phase_transition_guard
BEFORE UPDATE OF current_phase, phase_generation ON btcc_turn_states
WHEN (
  NEW.current_phase = OLD.current_phase AND
  NEW.phase_generation != OLD.phase_generation
) OR (
  NEW.current_phase != OLD.current_phase AND (
    NEW.phase_generation != OLD.phase_generation + 1 OR NOT EXISTS (
      SELECT 1 FROM btcc_phase_receipts receipt
      JOIN json_each(NEW.accepted_receipt_refs_json) accepted
        ON accepted.value = receipt.receipt_id
      WHERE receipt.turn_id = OLD.turn_id
        AND receipt.attempt_id = OLD.attempt_id
        AND receipt.phase = OLD.current_phase
        AND receipt.phase_generation = OLD.phase_generation
        AND receipt.next_state = NEW.current_phase
        AND receipt.status = 'passed'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'btcc_phase_receipt_required');
END;

CREATE TRIGGER IF NOT EXISTS btcc_turn_states_terminal_immutable
BEFORE UPDATE ON btcc_turn_states
WHEN OLD.lifecycle_status IN ('delivered', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'btcc_turn_terminal_immutable');
END;
`;
