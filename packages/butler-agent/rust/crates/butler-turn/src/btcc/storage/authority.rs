//! Synchronous authority fragments used inside other BTCC transactions.
use crate::btcc::authority::contracts::{AuthorityRecord, AuthorityResult};
use rusqlite::Connection;

mod close;
mod query;
mod write;

pub(super) use close::{close_pending_self_session_requests, close_pending_source_work_requests};
pub(crate) use repository::SqliteAuthorityRepository;

mod repository;

impl super::BtccStorage {
    pub(crate) async fn authority_session_requests(
        &self,
        owner: String,
        turns: Vec<String>,
    ) -> super::StorageResult<AuthorityResult<(Vec<AuthorityRecord>, Vec<AuthorityRecord>)>> {
        self.read(move |db| Ok(session_requests(db, &owner, &turns)))
            .await
    }
}

fn session_requests(
    db: &Connection,
    owner: &str,
    turns: &[String],
) -> AuthorityResult<(Vec<AuthorityRecord>, Vec<AuthorityRecord>)> {
    Ok((
        query::list_pending(db, owner)?,
        query::question_history(db, owner, turns)?,
    ))
}
