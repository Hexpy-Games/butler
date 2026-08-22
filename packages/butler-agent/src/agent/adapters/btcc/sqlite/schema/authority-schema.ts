export const BTCC_AUTHORITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_authority_requests (
  request_id TEXT PRIMARY KEY,
  request_ref TEXT NOT NULL UNIQUE,
  identity_sha256 TEXT NOT NULL UNIQUE,
  owner_session_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_work_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  authority_generation INTEGER NOT NULL,
  capability TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  normalized_input_json TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category = 'command'),
  reason TEXT NOT NULL,
  executable TEXT NOT NULL,
  command_count INTEGER NOT NULL CHECK (command_count >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'allowed', 'denied', 'modified')),
  schedule_client_message_id TEXT NOT NULL UNIQUE,
  schedule_input_text TEXT NOT NULL,
  private_alternative_input TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'failed', 'uncertain')),
  outcome_receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_btcc_authority_requests_owner_pending
ON btcc_authority_requests(owner_session_id, decision, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_btcc_authority_requests_slot_action
ON btcc_authority_requests(source_work_id, plan_revision_id, action_key, capability, authority_generation);
`;
