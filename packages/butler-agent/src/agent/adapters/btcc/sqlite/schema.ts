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

CREATE TABLE IF NOT EXISTS btcc_admission_claims (
  claim_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  status TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS btcc_opening_projections (
  turn_id TEXT PRIMARY KEY,
  projection_ref TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_programs (
  program_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  goal_contract_ref TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  accepted_plan_ref TEXT,
  planning_review_ref TEXT,
  frontier TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_work_items (
  work_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  work_ref TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS btcc_tasks (
  task_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  task_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  current_attempt_id TEXT,
  result_ref TEXT,
  review_ref TEXT
);

CREATE TABLE IF NOT EXISTS btcc_attempts (
  attempt_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_ref TEXT NOT NULL,
  previous_attempt_id TEXT,
  correction_plan_ref TEXT,
  execution_target_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  result_ref TEXT,
  review_ref TEXT
);
`;
