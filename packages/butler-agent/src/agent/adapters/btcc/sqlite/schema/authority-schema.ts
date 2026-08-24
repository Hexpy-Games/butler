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
  close_reason TEXT CHECK (
    close_reason IS NULL OR
    close_reason IN (
      'session_archived', 'session_permanently_deleted', 'session_cancelled',
      'work_abandoned'
    )
  ),
  close_scope TEXT CHECK (
    close_scope IS NULL OR close_scope IN ('self_session', 'work')
  ),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (close_reason IS NULL AND close_scope IS NULL AND closed_at IS NULL) OR
    (
      close_reason IS NOT NULL AND close_scope IS NOT NULL AND closed_at IS NOT NULL
      AND decision = 'pending' AND outcome = 'pending'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_btcc_authority_requests_owner_pending
ON btcc_authority_requests(owner_session_id, decision, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_btcc_authority_requests_slot_action
ON btcc_authority_requests(source_work_id, plan_revision_id, action_key, capability, authority_generation);
`;
