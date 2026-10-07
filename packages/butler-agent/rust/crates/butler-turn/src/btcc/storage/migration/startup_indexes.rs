//! Sparse legacy candidates, including malformed nullable historical schemas.
use rusqlite::{Connection, OptionalExtension};

const CANDIDATES: &str = "CREATE INDEX idx_btcc_turn_cutover_candidates ON btcc_turns(turn_id)
WHERE semantic_state NOT IN ('admitted','delivery_committed','delivered','cancelled')";

/// All migrations still run. Only a missing historical index needs the larger
/// temporary reader window; current installations retain their runtime cache.
pub(super) fn needs_backfill(db: &Connection) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT COUNT(*)<16 OR EXISTS(SELECT 1 FROM sqlite_schema
         WHERE name='idx_btcc_turn_cutover_candidates' AND sql<>?1)
         FROM sqlite_schema WHERE type='index' AND name IN (
         'idx_btcc_turns_authority_waiting','idx_btcc_subsession_outbox_pending',
         'idx_btcc_turn_checkpoint_reference','idx_btcc_turn_outbox_reference',
         'idx_btcc_turn_message_reference','idx_btcc_turn_cutover_candidates',
         'idx_btcc_turn_cutover_null_states','idx_btcc_activity_page',
         'idx_btcc_activity_identity','idx_btcc_activity_open_page',
         'idx_btcc_activity_parent_page','idx_btcc_activity_parent_open_page',
         'idx_btcc_work_monitor','idx_btcc_work_latest_binding',
         'idx_btcc_permission_sources','idx_btcc_permissions_active')",
        [CANDIDATES],
        |row| row.get(0),
    )
}

pub(super) fn cutover(db: &Connection) -> rusqlite::Result<()> {
    let existing: Option<String> = db.query_row(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_btcc_turn_cutover_candidates'",
        [], |row| row.get(0),
    ).optional()?;
    // SQLite simplifies the IS NULL arm on the current NOT NULL column before
    // proving partial-index eligibility. An OR predicate cannot serve either
    // arm there; separate UNION arms and indexes preserve both candidate sets.
    if existing.as_deref() != Some(CANDIDATES) {
        db.execute_batch("DROP INDEX IF EXISTS idx_btcc_turn_cutover_candidates")?;
        db.execute_batch(CANDIDATES)?;
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_btcc_turn_cutover_null_states
        ON btcc_turns(turn_id) WHERE semantic_state IS NULL",
    )
}
