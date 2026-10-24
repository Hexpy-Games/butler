use super::*;

/// Owns a canon transaction on the existing BTCC writer lane.
pub struct Transaction<'conn> {
    inner: rusqlite::Transaction<'conn>,
}
impl<'conn> Transaction<'conn> {
    pub fn new(inner: rusqlite::Transaction<'conn>) -> Result<Self> {
        Ok(Self { inner })
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
