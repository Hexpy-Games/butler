//! Synchronous authority fragments used inside other BTCC transactions.
use crate::btcc::authority::contracts::{AuthorityRecord, AuthorityResult};
use rusqlite::Connection;

mod close;
pub(crate) mod pending_asks;
mod query;
mod reader;
pub(crate) use reader::SqliteAuthorityReader;
mod write;

pub(super) use close::{close_pending_self_session_requests, close_pending_source_work_requests};
pub(crate) use repository::SqliteAuthorityRepository;

mod repository;

impl super::BtccStorage {
    pub(crate) async fn ask_reminder_records(
        &self,
        owner: String,
        turn: String,
    ) -> super::StorageResult<AuthorityResult<Vec<AuthorityRecord>>> {
        self.read(move |db| {
            Ok(query::many(
                db,
                &pending_asks::reminder_sql(),
                &[&owner, &turn],
            ))
        })
        .await
    }

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

impl super::BtccStorage {
    pub(crate) async fn pending_ask_records(
        &self,
        owner: Option<String>,
        limit: usize,
        before: Option<String>,
    ) -> super::StorageResult<AuthorityResult<Vec<AuthorityRecord>>> {
        self.read(move |db| {
            Ok(match owner {
                Some(owner) => query::list_pending(db, &owner),
                None => pending_asks::global(db, limit, before.as_deref()),
            })
        })
        .await
    }
    pub(crate) async fn pending_ask_changes(
        &self,
        after: i64,
    ) -> super::StorageResult<AuthorityResult<Vec<crate::btcc::PendingAskChange>>> {
        self.read(move |db| Ok(pending_asks::changes(db, after)))
            .await
    }
    pub(crate) async fn ack_pending_asks(&self, through: i64) -> super::StorageResult<()> {
        self.execute(move |db| {
            db.execute(pending_asks::ACK, [through])
                .map_err(super::StorageError::sqlite)?;
            Ok(())
        })
        .await
    }
    pub(crate) async fn dismiss_pending_question(
        &self,
        owner: String,
        reference: String,
        receipt: String,
        now: String,
    ) -> super::StorageResult<bool> {
        self.execute(move |db| {
            db.execute(
                pending_asks::DISMISS,
                rusqlite::params![reference, owner, receipt, now],
            )
            .map(|n| n == 1)
            .map_err(super::StorageError::sqlite)
        })
        .await
    }
}

#[cfg(feature = "test-support")]
pub(super) fn pending_ask_statements() -> Vec<(String, &'static str)> {
    vec![
        (
            pending_asks::global_sql(false),
            "idx_btcc_authority_open_v2",
        ),
        (pending_asks::global_sql(true), "idx_btcc_authority_open_v2"),
        (pending_asks::CHANGES.into(), "INTEGER PRIMARY KEY"),
        (pending_asks::ACK.into(), "INTEGER PRIMARY KEY"),
        (
            pending_asks::CLOSE_QUESTIONS.into(),
            "idx_btcc_questions_deferred",
        ),
        (
            pending_asks::DISMISS.into(),
            "sqlite_autoindex_btcc_authority_requests_2",
        ),
        (pending_asks::reminder_sql(), "idx_btcc_questions_settled"),
    ]
}
#[cfg(feature = "test-support")]
pub(super) fn existing_ask_statements() -> Vec<String> {
    vec![
        query::pending_sql(),
        query::ATTENTION_SQL.into(),
        close::CLOSE_SOURCE_WORK.into(),
        close::CLOSE_OWNER.into(),
    ]
}
