//! Delta batches already have an operation savepoint and roll back as a unit.
use rusqlite::{Connection, Savepoint};
use std::ops::Deref;

pub(super) enum Transaction<'a> {
    Reserved(&'a Connection),
    Savepoint(Savepoint<'a>),
}

impl<'a> Transaction<'a> {
    pub(super) fn begin(db: &'a mut Connection) -> rusqlite::Result<Self> {
        if super::batch::active() {
            debug_assert!(!db.is_autocommit());
            Ok(Self::Reserved(db))
        } else {
            db.savepoint().map(Self::Savepoint)
        }
    }

    pub(super) fn commit(self) -> rusqlite::Result<()> {
        match self {
            Self::Reserved(_) => Ok(()),
            Self::Savepoint(savepoint) => savepoint.commit(),
        }
    }
}

impl Deref for Transaction<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        match self {
            Self::Reserved(db) => db,
            Self::Savepoint(savepoint) => savepoint,
        }
    }
}
