use super::*;

/// Owns the outbox boundary along with the caller's SQLite transaction.
/// Coalescing only touches rows appended after this boundary, so rollback and
/// savepoints retain SQLite's normal semantics.
pub struct Transaction<'conn> {
    pub(super) effects: std::cell::RefCell<Option<super::migration::Effects>>,
    inner: rusqlite::Transaction<'conn>,
    pub(super) outbox_start: i64,
}
impl<'conn> Transaction<'conn> {
    pub fn new(inner: rusqlite::Transaction<'conn>) -> Result<Self> {
        let outbox_start = inner.query_row(sql::OUTBOX_START, [], |row| row.get(0))?;
        Ok(Self {
            inner,
            effects: std::cell::RefCell::new(None),
            outbox_start,
        })
    }
    pub fn commit(self) -> rusqlite::Result<()> {
        self.inner.commit()
    }
    pub fn rollback(self) -> rusqlite::Result<()> {
        self.inner.rollback()
    }
}
impl<'conn> std::ops::Deref for Transaction<'conn> {
    type Target = rusqlite::Transaction<'conn>;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
