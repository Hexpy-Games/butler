use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::read;
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::{AppApplication, app_error, events, storage::AppStorageError};
use crate::public_text::trim_js_whitespace;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) struct AppSessionUpdate {
    pub title: Option<String>,
    pub archived: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppSessionActionResult {
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
        self.read_session_row(session_id.clone()).await?;
        if archived {
            if session_id == "general" {
                return Err(public(
                    409,
                    "general_channel_protected",
                    "일반 채널은 보관하거나 삭제할 수 없습니다.",
                ));
            }
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
                    session,
                    title,
                    input.archived,
                    clock.as_ref(),
                )
            })
            .await
            .map_err(app_error)?;
        Ok(updated)
    }

    pub(crate) async fn archive_session_owned(
        &self,
        session_id: String,
        title: Option<String>,
    ) -> Result<AppSessionActionResult, GatewayApplicationError> {
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
        self.close_session_authority(&session_id, "session_archived")
            .await?;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let session = session_id.clone();
        self.storage
            .execute(move |db| {
                mutate_session(db, &subscribers, session, title, Some(true), clock.as_ref())
            })
            .await
            .map_err(app_error)
    }

    pub(crate) async fn delete_session_owned(
        &self,
        session_id: String,
        permanent: bool,
    ) -> Result<AppSessionActionResult, GatewayApplicationError> {
        let _target = self.read_session_row(session_id.clone()).await?;
        if session_id == "general" {
            return Err(public(
                409,
                "general_channel_protected",
                "일반 채널은 보관하거나 삭제할 수 없습니다.",
            ));
        }
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
        self.storage
            .execute(move |db| {
                if permanent {
                    delete_permanently(db, &subscribers, &session_id, clock.as_ref())
                } else {
                    mutate_session(
                        db,
                        &subscribers,
                        session_id,
                        None,
                        Some(true),
                        clock.as_ref(),
                    )
                }
            })
            .await
            .map_err(app_error)
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
        let runtime_session_id = crate::gateway::app_session_hint(session_id);
        self.dependencies
            .authority_handoff
            .close_self_session(runtime_session_id, reason.to_owned())
            .await
    }
}

fn mutate_session(
    db: &mut Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    session_id: String,
    title: Option<String>,
    archived: Option<bool>,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppSessionActionResult, AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    let current = read::session(&tx, &session_id)?;
    if session_id == "general" && archived == Some(true) {
        return Err(AppStorageError::new(
            "general_channel_protected",
            "일반 채널은 보관하거나 삭제할 수 없습니다.",
        ));
    }
    let title = title.unwrap_or(current.title);
    let archived = archived.map_or(current.archived, |value| value);
    let now = clock.now_iso();
    tx.execute(
        "UPDATE chats SET title=?1,archived=?2,updated_at=?3 WHERE id=?4",
        params![title, i32::from(archived), now, session_id],
    )
    .map_err(AppStorageError::sqlite)?;
    let session = read::session(&tx, &session_id)?;
    let event = events::append_unpublished(
        &tx,
        "session.updated",
        None,
        crate::json::json_object!({"session":session}),
        &clock.now_iso(),
    )?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, event);
    Ok(AppSessionActionResult { session })
}

fn delete_permanently(
    db: &mut Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    session_id: &str,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppSessionActionResult, AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    let session = read::session(&tx, session_id)?;
    if session_id == "general" {
        return Err(AppStorageError::new(
            "general_channel_protected",
            "일반 채널은 보관하거나 삭제할 수 없습니다.",
        ));
    }
    tx.execute("DELETE FROM chats WHERE id=?", [session_id])
        .map_err(AppStorageError::sqlite)?;
    let event = events::append_unpublished(
        &tx,
        "session.permanently_deleted",
        None,
        crate::json::json_object!({"session":session}),
        &clock.now_iso(),
    )?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, event);
    Ok(AppSessionActionResult { session })
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
