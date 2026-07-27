export const BTCC_WORK_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_programs (
  program_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  goal_contract_ref TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  accepted_plan_ref TEXT,
  accepted_plan_candidate_ref TEXT,
  planning_review_ref TEXT,
  pending_correction_plan_ref TEXT,
  promotion_assembly_refs_json TEXT,
  promotion_permit_ref TEXT,
  active_deferral_ref TEXT,
  active_deferral_turn_id TEXT,
  promotion_deferral_ref TEXT,
  cancellation_ref TEXT,
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
