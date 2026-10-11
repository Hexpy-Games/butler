//! These agent tables deliberately live outside the exact BTCC manifest.
pub(in crate::btcc::storage) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agent_acceptance_reclaims (
 turn_id TEXT PRIMARY KEY, enqueued_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS agent_storage_corrections (
 name TEXT PRIMARY KEY, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 detail_json TEXT, updated_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS acceptance_reclaim_on_settle
AFTER UPDATE OF semantic_state ON btcc_turns
WHEN OLD.semantic_state = 'admitted' AND NEW.semantic_state <> 'admitted'
 AND EXISTS (SELECT 1 FROM btcc_model_round_acceptances WHERE turn_id = NEW.turn_id)
BEGIN
 INSERT OR IGNORE INTO agent_acceptance_reclaims(turn_id,enqueued_at)
 VALUES (NEW.turn_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
";
