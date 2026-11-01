use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::{cleanup, read};
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::application::{AppApplication, app_error, events, storage::AppStorageError};
use butler_core::public_text::trim_js_whitespace;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AppSessionUpdate {
    pub title: Option<String>,
    pub archived: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppSessionActionResult {
    pub session: super::AppSessionSummary,
}

impl AppApplication {
    pub(crate) async fn update_session_owned(
        &self,
        session_id: String,
        input: AppSessionUpdate,
    ) -> Result<AppSessionActionResult, GatewayApplicationError> {
        let title = input
            .title
            .as_deref()
            .map(trim_js_whitespace)
            .map(str::to_owned);
        if input.title.is_some() && title.as_deref().is_none_or(str::is_empty) {
            return Err(public(
                400,
                "session_title_required",
                "Session title is required.",
            ));
        }
        let archived = input.archived.unwrap_or(false);
        if archived {
            self.ensure_output_transfer_complete(&session_id).await?;
            super::cleanup::replay(self).await;
        }
        let cleanup_guard = self.session_cleanup_locks.acquire(session_id.clone()).await;
        self.read_session_row(session_id.clone()).await?;
        if archived {
            if session_id == "general" {
                return Err(public(
                    409,
                    "general_channel_protected",
                    "일반 채널은 보관하거나 삭제할 수 없습니다.",
                ));
            }
            self.stop_session_work(&session_id, true).await;
            self.close_session_authority(&session_id, "session_archived")
                .await?;
        }
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let session = session_id.clone();
        let updated = self
            .storage
            .execute(move |db| {
                mutate_session(
                    db,
                    &subscribers,
                    &session,
                    title,
                    input.archived,
                    clock.as_ref(),
                )
            })
            .await
            .map_err(app_error)?;
        if archived {
            super::cleanup::complete_locked(self, session_id, &cleanup_guard)
                .await
                .map_err(GatewayApplicationError::after_commit)?;
        }
        Ok(updated)
    }

    pub(crate) async fn archive_session_owned(
        &self,
        session_id: String,
        title: Option<String>,
    ) -> Result<AppSessionActionResult, GatewayApplicationError> {
        self.ensure_output_transfer_complete(&session_id).await?;
        super::cleanup::replay(self).await;
        let cleanup_guard = self.session_cleanup_locks.acquire(session_id.clone()).await;
        self.read_session_row(session_id.clone()).await?;
        if session_id == "general" {
            return Err(public(
                409,
                "general_channel_protected",
                "일반 채널은 보관하거나 삭제할 수 없습니다.",
            ));
        }
        let title = title.as_deref().map(trim_js_whitespace).map(str::to_owned);
        if title.as_deref().is_some_and(str::is_empty) {
            return Err(public(
                400,
                "session_title_required",
                "Session title is required.",
            ));
        }
        self.stop_session_work(&session_id, true).await;
        self.close_session_authority(&session_id, "session_archived")
            .await?;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let session = session_id.clone();
        let result = self
            .storage
            .execute(move |db| {
                mutate_session(
                    db,
                    &subscribers,
                    &session,
                    title,
                    Some(true),
                    clock.as_ref(),
                )
            })
            .await
            .map_err(app_error)?;
        super::cleanup::complete_locked(self, session_id, &cleanup_guard)
            .await
            .map_err(GatewayApplicationError::after_commit)?;
        Ok(result)
    }

    pub(crate) async fn delete_session_owned(
        &self,
        session_id: String,
        permanent: bool,
    ) -> Result<AppSessionActionResult, GatewayApplicationError> {
        self.ensure_output_transfer_complete(&session_id).await?;
        super::cleanup::replay(self).await;
        let cleanup_guard = self.session_cleanup_locks.acquire(session_id.clone()).await;
        self.read_session_row(session_id.clone()).await?;
        if session_id == "general" {
            return Err(public(
                409,
                "general_channel_protected",
                "일반 채널은 보관하거나 삭제할 수 없습니다.",
            ));
        }
        self.stop_session_work(&session_id, !permanent).await;
        self.close_session_authority(
            &session_id,
            if permanent {
                "session_permanently_deleted"
            } else {
                "session_archived"
            },
        )
        .await?;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let session = session_id.clone();
        let result = self
            .storage
            .execute(move |db| {
                if permanent {
                    delete_permanently(db, &subscribers, &session_id, clock.as_ref())
                } else {
                    mutate_session(
                        db,
                        &subscribers,
                        &session_id,
                        None,
                        Some(true),
                        clock.as_ref(),
                    )
                }
            })
            .await
            .map_err(app_error)?;
        // Each owner clears its own receipt, regardless of the other's result.
        let canon = async {
            if !permanent {
                return Ok(());
            }
            #[cfg(feature = "e2e-fixtures")]
            super::super::canon::hold(self, "canon_session_delete").await?;
            super::super::canon_queue::complete_delete(self, format!("session-delete:{session}"))
                .await
        }
        .await;
        let cleanup = super::cleanup::complete_locked(self, session, &cleanup_guard).await;
        cleanup::combine_failures(
            [("canon", canon), ("cleanup", cleanup)]
                .into_iter()
                .filter_map(|(step, result)| result.err().map(|error| (step.to_owned(), error)))
                .collect(),
        )
        .map_err(GatewayApplicationError::after_commit)?;
        if !permanent {
            self.assets_owned(super::super::AppAssetCommand::Sweep)
                .await
                .map_err(GatewayApplicationError::after_commit)?;
        }
        Ok(result)
    }

    async fn read_session_row(
        &self,
        session_id: String,
    ) -> Result<super::AppSessionSummary, GatewayApplicationError> {
        self.storage
            .execute(move |db| read::session(db, &session_id))
            .await
            .map_err(app_error)
    }

    async fn close_session_authority(
        &self,
        session_id: &str,
        reason: &str,
    ) -> Result<(), GatewayApplicationError> {
        let runtime_session_id = self.runtime_hint(session_id).await?;
        self.dependencies
            .authority_handoff
            .close_self_session(runtime_session_id.clone(), reason.to_owned())
            .await?;
        self.memory_owned(
            super::super::AppMemoryCommand::EndSession {
                session_id: runtime_session_id,
            },
            tokio_util::sync::CancellationToken::new(),
        )
        .await?;
        Ok(())
    }
}

fn mutate_session(
    db: &mut Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    session_id: &str,
    title: Option<String>,
    archived: Option<bool>,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppSessionActionResult, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let current = read::session(&tx, session_id)?;
    if session_id == "general" && archived == Some(true) {
        return Err(AppStorageError::new(
            AppStorageCode::GeneralChannelProtected,
            "일반 채널은 보관하거나 삭제할 수 없습니다.",
        ));
    }
    let title = title.unwrap_or(current.title);
    let archive_requested = archived == Some(true);
    let archived = archived.unwrap_or(current.archived);
    let now = clock.now_iso();
    tx.execute(
        "UPDATE chats SET title=?1,archived=?2,updated_at=?3 WHERE id=?4",
        params![title, i32::from(archived), now, session_id],
    )
    .map_err(AppStorageError::sqlite)?;
    if !archived {
        tx.execute(
            "DELETE FROM app_session_delete_cleanups WHERE session_id=?1 AND kind='archive'",
            [session_id],
        )
        .map_err(AppStorageError::sqlite)?;
    } else if archive_requested {
        tx.execute(
            "INSERT INTO app_session_delete_cleanups(session_id,kind) VALUES(?1,'archive') \
             ON CONFLICT(session_id) DO NOTHING",
            [session_id],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    finish_update(tx, subscribers, session_id, clock)
}

fn delete_permanently(
    db: &mut Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    session_id: &str,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppSessionActionResult, AppStorageError> {
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let session = read::session(&tx, session_id)?;
    if session_id == "general" {
        return Err(AppStorageError::new(
            AppStorageCode::GeneralChannelProtected,
            "일반 채널은 보관하거나 삭제할 수 없습니다.",
        ));
    }
    cleanup::record_delete(&tx, session_id, &session.session_hint)?;
    tx.execute(
        "DELETE FROM app_initiated_messages WHERE chat_id=?1",
        [session_id],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute(
        "INSERT INTO app_canon_session_deletes(op_id,session_hint) VALUES(?1,?2)",
        params![format!("session-delete:{session_id}"), session.session_hint],
    )
    .map_err(AppStorageError::sqlite)?;
    tx.execute("DELETE FROM chats WHERE id=?", [session_id])
        .map_err(AppStorageError::sqlite)?;
    let event = events::append_unpublished(
        &tx,
        "session.permanently_deleted",
        None,
        butler_core::json::json_object!({"session":session}),
        &clock.now_iso(),
    )?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, &event);
    Ok(AppSessionActionResult { session })
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
        source: None,
    }
}

pub(in crate::gateway::application) fn compare_and_set_title(
    db: &mut Connection,
    subscribers: &events::EventSubscribers,
    id: &str,
    expected: &str,
    title: &str,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<(), AppStorageError> {
    if title == expected {
        return Ok(());
    }
    let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
    let changed = tx
        .execute(
            "UPDATE chats SET title=?1,updated_at=?2 WHERE id=?3 AND title=?4",
            params![title, clock.now_iso(), id, expected],
        )
        .map_err(AppStorageError::sqlite)?;
    if changed == 0 {
        tx.commit().map_err(AppStorageError::sqlite)?;
        return Ok(());
    }
    finish_update(tx, subscribers, id, clock).map(|_| ())
}

fn finish_update(
    tx: rusqlite::Savepoint<'_>,
    subscribers: &events::EventSubscribers,
    session_id: &str,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppSessionActionResult, AppStorageError> {
    let session = read::session(&tx, session_id)?;
    let event = events::append_unpublished(
        &tx,
        "session.updated",
        None,
        butler_core::json::json_object!({"session":session}),
        &clock.now_iso(),
    )?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, &event);
    Ok(AppSessionActionResult { session })
}
