// Source-compatible SQLite schema; additive `IF NOT EXISTS` statements preserve deployed data.
pub(in crate::btcc::storage) const LEGACY_SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS btcc_r3_legacy_turn_cutovers (
  cutover_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE,
  source_semantic_state TEXT NOT NULL CHECK (
    source_semantic_state IN ('conception_opening', 'assisted_answer', 'conception_deliberation', 'contract_review', 'planning', 'planning_review', 'work_frontier', 'task_execution', 'task_review', 'feedback_conception', 'feedback_planning', 'feedback_planning_review', 'consolidation', 'reporting')
  ),
  source_turn_revision INTEGER NOT NULL,
  source_execution_fence INTEGER NOT NULL,
  source_active_checkpoint_id TEXT,
  admitted_checkpoint_id TEXT NOT NULL UNIQUE,
  admitted_turn_revision INTEGER NOT NULL,
  admitted_execution_fence INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  cutover_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS btcc_r3_legacy_turn_cutovers_immutable_update
BEFORE UPDATE ON btcc_r3_legacy_turn_cutovers
BEGIN
  SELECT RAISE(ABORT, 'BTCC R3 legacy Turn cutover evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_r3_legacy_turn_cutovers_immutable_delete
BEFORE DELETE ON btcc_r3_legacy_turn_cutovers
BEGIN
  SELECT RAISE(ABORT, 'BTCC R3 legacy Turn cutover evidence is immutable');
END;

CREATE TABLE IF NOT EXISTS btcc_r3_legacy_turn_quarantine (
  turn_id TEXT PRIMARY KEY,
  reason_json TEXT NOT NULL,
  reason_sha256 TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS btcc_r3_legacy_turn_quarantine_immutable_update
BEFORE UPDATE ON btcc_r3_legacy_turn_quarantine
BEGIN
  SELECT RAISE(ABORT, 'BTCC R3 legacy Turn quarantine is immutable');
END;

CREATE TRIGGER IF NOT EXISTS btcc_r3_legacy_turn_quarantine_immutable_delete
BEFORE DELETE ON btcc_r3_legacy_turn_quarantine
BEGIN
  SELECT RAISE(ABORT, 'BTCC R3 legacy Turn quarantine is immutable');
END;
";
