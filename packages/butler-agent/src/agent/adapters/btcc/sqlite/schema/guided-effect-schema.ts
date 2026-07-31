export const BTCC_GUIDED_EFFECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS btcc_guided_effects (
  effect_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  identity_sha256 TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  target_sha256 TEXT NOT NULL,
  work_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  capability TEXT NOT NULL,
  sanitized_target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'dispatching', 'applied', 'uncertain', 'failed')
  ),
  journal_revision INTEGER NOT NULL,
  dispatch_attempts INTEGER NOT NULL,
  result_json TEXT,
  receipt_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  CHECK (
    (status = 'applied' AND result_json IS NOT NULL
      AND receipt_json IS NOT NULL AND applied_at IS NOT NULL)
    OR
    (status != 'applied' AND result_json IS NULL
      AND receipt_json IS NULL AND applied_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_btcc_guided_effects_work
ON btcc_guided_effects(work_id, plan_revision_id, action_key);

CREATE INDEX IF NOT EXISTS idx_btcc_guided_effects_recovery
ON btcc_guided_effects(status, updated_at);
`;
