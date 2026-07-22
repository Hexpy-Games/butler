export const BTCC_PHASE_CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_phase_operation_results (
  operation_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  UNIQUE(checkpoint_id, checkpoint_revision, request_id)
);

CREATE TABLE IF NOT EXISTS btcc_phase_model_rounds (
  round_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  round_ordinal INTEGER NOT NULL,
  carrier_kind TEXT NOT NULL,
  actual_identity_json TEXT NOT NULL,
  UNIQUE(checkpoint_id, checkpoint_revision, round_ordinal)
);

CREATE TABLE IF NOT EXISTS btcc_phase_checkpoint_revisions (
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  previous_revision_ref TEXT NOT NULL,
  phase_envelope_ref TEXT,
  phase_envelope_json TEXT,
  provider_round_ref TEXT,
  provider_round_json TEXT,
  pending_operation_json TEXT,
  pending_submission_ref TEXT,
  pending_submission_json TEXT,
  product_bundle_ref TEXT,
  product_bundle_json TEXT,
  operation_result_refs_json TEXT,
  state_claim_id TEXT NOT NULL,
  execution_fence INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY(checkpoint_id, checkpoint_revision)
);

CREATE TABLE IF NOT EXISTS btcc_ledger_contentions (
  contention_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  turn_revision INTEGER NOT NULL,
  semantic_state TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  checkpoint_revision INTEGER NOT NULL,
  pending_submission_ref TEXT NOT NULL,
  pending_submission_json TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  base_manifest_revision INTEGER NOT NULL,
  base_manifest_hash TEXT NOT NULL,
  contention_kind TEXT NOT NULL,
  base_project_head_json TEXT NOT NULL,
  winning_publication_id TEXT,
  claim_path TEXT NOT NULL,
  winning_owner_id TEXT,
  owner_generation INTEGER NOT NULL,
  activation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(turn_id, turn_revision)
);

CREATE INDEX IF NOT EXISTS idx_btcc_ledger_contentions_activation
ON btcc_ledger_contentions(status, activation_key);
`;
