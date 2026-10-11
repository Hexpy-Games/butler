//! Additive, non-manifest startup correction bookkeeping.
pub(super) fn ensure(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(super::super::schema::correction::SCHEMA)
}
