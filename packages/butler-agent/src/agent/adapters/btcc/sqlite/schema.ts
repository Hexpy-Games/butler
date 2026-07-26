import { BTCC_PHASE_CONVERSATION_SCHEMA } from "./schema/phase-conversation-schema.ts";

export const BTCC_SUCCESSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_inbound_inbox (
  inbox_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  admission_input_hash TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(session_id, trigger_key)
);

CREATE TABLE IF NOT EXISTS btcc_continuation_triggers (
  trigger_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  authorization_ref TEXT NOT NULL,
  content TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_admission_claims (
  claim_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_runtime_owners (
  owner_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  process_id INTEGER NOT NULL,
  process_started_at_ms INTEGER NOT NULL,
  owner_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS btcc_records (
  record_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL UNIQUE,
  trigger_key TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  original_message TEXT NOT NULL,
  admission_snapshot_ref TEXT NOT NULL,
  model_selection_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  continuation_snapshot_json TEXT NOT NULL,
  semantic_state TEXT NOT NULL,
  active_checkpoint_id TEXT,
  route TEXT,
  opening_answer_json TEXT,
  managed_state_json TEXT,
  final_payload_json TEXT,
  goal_contract_ref TEXT,
  final_dossier_ref TEXT,
  delivery_outbox_id TEXT,
  canonical_assistant_message_id TEXT,
  revision INTEGER NOT NULL,
  execution_fence INTEGER NOT NULL,
  final_disposition TEXT
);

CREATE TABLE IF NOT EXISTS btcc_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  semantic_state TEXT NOT NULL,
  kind TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  active_claim_id TEXT,
  accepted_product_json TEXT,
  actual_identity_json TEXT,
  is_active INTEGER NOT NULL,
  UNIQUE(turn_id, turn_revision, semantic_state)
);

CREATE TABLE IF NOT EXISTS btcc_state_claims (
  claim_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  semantic_state TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  execution_fence INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(turn_id, turn_revision, semantic_state)
);

CREATE TABLE IF NOT EXISTS btcc_operational_interruptions (
  interruption_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  semantic_state TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  claim_id TEXT NOT NULL,
  execution_fence INTEGER NOT NULL,
  code TEXT NOT NULL,
  activation_kind TEXT NOT NULL,
  diagnostic_message TEXT,
  activation_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  interrupted_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(claim_id, code, activation_kind)
);

CREATE INDEX IF NOT EXISTS idx_btcc_operational_interruption_turn
ON btcc_operational_interruptions(turn_id, status);

CREATE TABLE IF NOT EXISTS btcc_stop_requests (
  stop_request_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  observed_turn_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

${BTCC_PHASE_CONVERSATION_SCHEMA}

CREATE TABLE IF NOT EXISTS btcc_delivery_outbox (
  outbox_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  committed_turn_revision INTEGER NOT NULL,
  payload_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  expected_message_id TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_canonical_deliveries (
  turn_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE,
  assistant_message_id TEXT NOT NULL UNIQUE,
  inserted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_learning_sources (
  source_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  final_payload_ref TEXT NOT NULL,
  source_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_learning_candidate_outbox (
  outbox_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_phase_guidance (
  guidance_revision_id TEXT PRIMARY KEY,
  guidance_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  guidance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(guidance_id, phase, scope_kind, scope_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_btcc_phase_guidance_lookup
ON btcc_phase_guidance(phase, scope_kind, scope_id, status);

CREATE TABLE IF NOT EXISTS btcc_retrospectives (
  source_id TEXT PRIMARY KEY,
  retrospective_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_retrospective_decisions (
  source_id TEXT PRIMARY KEY,
  decisions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_learning_diagnostics (
  outbox_id TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_context_documents (
  context_ref TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  projection_class TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scope_kind, scope_id, projection_class, source_id, source_revision)
);

CREATE TABLE IF NOT EXISTS btcc_opening_projections (
  turn_id TEXT PRIMARY KEY,
  projection_ref TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_programs (
  program_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  goal_contract_ref TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  accepted_plan_ref TEXT,
  planning_review_ref TEXT,
  pending_correction_plan_ref TEXT,
  promotion_assembly_refs_json TEXT,
  promotion_permit_ref TEXT,
  active_deferral_ref TEXT,
  active_deferral_turn_id TEXT,
  promotion_deferral_ref TEXT,
  frontier TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL,
  available_specs_json TEXT NOT NULL DEFAULT '[]',
  governing_spec_refs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS btcc_work_items (
  work_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  work_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS btcc_tasks (
  task_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  task_ref TEXT NOT NULL,
  task_kind TEXT NOT NULL DEFAULT 'non_artifact',
  status TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  current_attempt_id TEXT,
  result_ref TEXT,
  review_ref TEXT,
  revalidation_source_json TEXT
);

CREATE TABLE IF NOT EXISTS btcc_attempts (
  attempt_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_ref TEXT NOT NULL,
  previous_attempt_id TEXT,
  correction_plan_ref TEXT,
  execution_target_ref TEXT NOT NULL,
  execution_target_binding_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  result_ref TEXT,
  review_ref TEXT
);

CREATE TABLE IF NOT EXISTS btcc_ledger_claims (
  claim_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  base_manifest_revision INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(ledger_id, program_id, base_manifest_revision)
);

CREATE TABLE IF NOT EXISTS btcc_ledger_mutations (
  mutation_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  mutation_kind TEXT NOT NULL,
  mutation_json TEXT NOT NULL,
  base_manifest_revision INTEGER NOT NULL,
  next_manifest_revision INTEGER NOT NULL,
  UNIQUE(ledger_id, program_id, next_manifest_revision)
);

CREATE TABLE IF NOT EXISTS btcc_project_planning_bases (
  candidate_ref TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  head_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_project_program_projections (
  program_id TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_ledger_promotion_outbox (
  outbox_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  committed_turn_revision INTEGER NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  ledger_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  publication_json TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(turn_id, committed_turn_revision)
);
`;
