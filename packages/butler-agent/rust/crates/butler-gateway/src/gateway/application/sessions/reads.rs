//! Read markers: which chats have a finished reply the owner has not seen.
//!
//! The marker is the message rowid of the latest finished assistant reply the
//! owner saw. Streaming, pending and retrying replies never count, so a turn
//! in progress does not flip the state on every delta. Marking a chat read is
//! one transaction (marker upsert plus a `session.read` event) and only when
//! the marker moves; a repeated read writes nothing.
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::gateway::GatewayApplicationError;
use crate::gateway::application::storage::{AppStorageCode, AppStorageError};
use crate::gateway::application::{
    AppApplication, AppIdentityClock, EventSubscribers, app_error, events,
};

/// SQL columns `latest_reply_rowid, read_rowid` for the chat row aliased `c`.
macro_rules! read_marker_columns {
    () => {
        r"(SELECT m.rowid FROM app_message_owners o CROSS JOIN messages m
   WHERE o.chat_id=c.id AND m.chat_id=o.source_chat_id
   AND m.rowid BETWEEN o.first_rowid AND o.last_rowid
   AND m.role='assistant' AND m.status NOT IN ('pending','streaming','retrying')
   AND NOT(m.safe_error_code IS NOT NULL
     AND m.safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete'))
   ORDER BY m.rowid DESC LIMIT 1) AS latest_reply_rowid,
 COALESCE((SELECT r.read_rowid FROM app_session_reads r WHERE r.chat_id=c.id),
   (SELECT b.baseline_rowid FROM app_session_read_baseline b),0) AS read_rowid"
    };
}
pub(super) use read_marker_columns;

/// True when a finished reply is newer than the read marker.
pub(super) fn unread(latest_reply_rowid: Option<i64>, read_rowid: i64) -> bool {
    latest_reply_rowid.is_some_and(|reply| reply > read_rowid)
}

#[derive(Clone, Debug, Serialize)]
pub struct AppSessionReadResult {
    pub session_id: String,
    /// False when the chat was already read: nothing was written.
    pub changed: bool,
    pub unread: bool,
}

impl AppApplication {
    pub(crate) async fn mark_session_read_owned(
        &self,
        session_id: String,
    ) -> Result<AppSessionReadResult, GatewayApplicationError> {
        self.surface_work_failures(Some(session_id.clone())).await?;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| mark_read(db, &subscribers, &session_id, clock.as_ref()))
            .await
            .map_err(app_error)
    }
}

fn mark_read(
    db: &mut Connection,
    subscribers: &EventSubscribers,
    session_id: &str,
    clock: &dyn AppIdentityClock,
) -> Result<AppSessionReadResult, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let markers: Option<(Option<i64>, i64)> = tx
        .query_row(
            concat!(
                "SELECT ",
                read_marker_columns!(),
                " FROM chats c WHERE c.id=?1"
            ),
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let (latest, read) = markers.ok_or_else(|| {
        AppStorageError::new(AppStorageCode::SessionNotFound, "Session not found.")
    })?;
    let result = |changed| AppSessionReadResult {
        session_id: session_id.to_owned(),
        changed,
        unread: false,
    };
    let Some(latest) = latest.filter(|latest| *latest > read) else {
        return Ok(result(false));
    };
    let now = clock.now_iso();
    tx.execute(
        "INSERT INTO app_session_reads(chat_id,read_rowid,read_at) VALUES(?1,?2,?3) \
         ON CONFLICT(chat_id) DO UPDATE SET read_rowid=excluded.read_rowid,read_at=excluded.read_at",
        params![session_id, latest, now],
    )
    .map_err(AppStorageError::sqlite)?;
    let event = events::append_unpublished(
        &tx,
        "session.read",
        None,
        butler_core::json::json_object!({"session_id":session_id,"unread":false}),
        &now,
    )?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, &event);
    Ok(result(true))
}
