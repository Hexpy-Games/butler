//! Sparse legacy candidates, including malformed nullable historical schemas.
use rusqlite::{Connection, OptionalExtension};

const CANDIDATES: &str = "CREATE INDEX idx_btcc_turn_cutover_candidates ON btcc_turns(turn_id)
WHERE semantic_state NOT IN ('admitted','delivery_committed','delivered','cancelled')";

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
