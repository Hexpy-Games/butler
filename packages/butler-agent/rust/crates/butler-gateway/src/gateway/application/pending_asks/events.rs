//! Durable source outboxes, drained on change signals only (including startup).
use super::*;
use crate::gateway::application::{
    AppAuthorityHandoff, EventSubscribers, events as app_events, service,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::Arc;

pub(crate) const ENQUEUE: &str =
    "INSERT INTO app_pending_ask_changes(chat_id,ask_id,state) VALUES(?1,?2,?3)";
pub(crate) const QUEUED: &str = "SELECT seq,chat_id,ask_id,state FROM app_pending_ask_changes WHERE seq>?1 ORDER BY seq LIMIT 128";
pub(crate) const CURSOR: &str = "SELECT seq FROM app_pending_ask_cursor WHERE id=1";
pub(crate) const ADVANCE: &str = "UPDATE app_pending_ask_cursor SET seq=?1 WHERE id=1";
pub(crate) const PRUNE: &str = "DELETE FROM app_pending_ask_changes WHERE seq<=?1";

pub(super) fn enqueue_plan(
    db: &Connection,
    subscribers: &EventSubscribers,
    chat: &str,
    id: &str,
    state: &str,
) -> Result<(), AppStorageError> {
    db.execute(ENQUEUE, params![chat, format!("plan:{id}"), state])
        .map_err(AppStorageError::sqlite)?;
    super::super::event_outbox::notify_after_commit(db, subscribers.pending_asks_wake.clone());
    Ok(())
}

pub(in crate::gateway::application) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.authority_handoff.pending_ask_signal() else {
        return;
    };
    let wake = app.subscribers.pending_asks_wake.clone();
    let app = app.clone_handle();
    let shutdown = app.dependencies.service_shutdown.clone();
    tokio::spawn(async move {
        loop {
            changes.borrow_and_update();
            let result = tokio::select! {
                () = shutdown.cancelled() => return,
                result = drain(&app) => result,
            };
            if let Err(error) = result {
                tracing::error!(%error,"Pending ask event relay failed");
            }
            tokio::select! {
                () = shutdown.cancelled() => return,
                () = wake.notified() => {},
                change = changes.changed() => if change.is_err() { return; },
            }
        }
    });
}

async fn drain(app: &AppApplication) -> Result<(), GatewayApplicationError> {
    let after = app
        .storage
        .read(|db| {
            db.query_row(CURSOR, [], |r| r.get(0))
                .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let port = &app.dependencies.authority_handoff;
    port.ack_pending_asks(after).await?;
    loop {
        let rows = port.pending_ask_changes(after).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let session = app.owner_chat(row.owner).await?;
            publish(
                app,
                port,
                &session,
                &format!("{}:{}", row.kind, row.request_ref),
                &row.kind,
                &row.state,
                Some(row.seq),
                None,
            )
            .await?;
            port.ack_pending_asks(row.seq).await?;
        }
    }
    loop {
        let rows: Vec<(i64, String, String, String)> = app
            .storage
            .read(|db| {
                db.prepare_cached(QUEUED)
                    .map_err(AppStorageError::sqlite)?
                    .query_map([0], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .map_err(AppStorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        if rows.is_empty() {
            break;
        }
        for (seq, chat, id, state) in rows {
            publish(
                app,
                port,
                &chat,
                &id,
                "plan_decision",
                &state,
                None,
                Some(seq),
            )
            .await?;
        }
    }
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "source outbox identities accompany the public event fields"
)]
async fn publish(
    app: &AppApplication,
    port: &Arc<dyn AppAuthorityHandoff>,
    chat: &str,
    id: &str,
    kind: &str,
    state: &str,
    authority_seq: Option<i64>,
    plan_seq: Option<i64>,
) -> Result<(), GatewayApplicationError> {
    let owner = app.runtime_hint(chat).await?;
    let count = port
        .pending_asks(Some(owner), usize::MAX, None)
        .await?
        .len();
    let (chat, id, kind, state) = (
        chat.to_owned(),
        id.to_owned(),
        kind.to_owned(),
        state.to_owned(),
    );
    let subscribers: EventSubscribers = app.subscribers.clone();
    let now = app.dependencies.identity_clock.now_iso();
    app.storage.execute(move |db| {
        let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
        let plan_count: usize = tx.query_row(plans::COUNT,[&chat],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
        let visible: Option<bool> = tx.query_row(CHAT,[&chat],|r|r.get(1)).optional().map_err(AppStorageError::sqlite)?;
        let open_count = if visible==Some(false) { count+plan_count } else { 0 };
        app_events::append(&tx,&subscribers,"pending_asks.changed",None,service::map(&json!({"session_id":chat,"ask_id":id,"kind":kind,"state":state,"open_count":open_count}))?,&now)?;
        if let Some(seq)=authority_seq { tx.execute(ADVANCE,[seq]).map_err(AppStorageError::sqlite)?; }
        if let Some(seq)=plan_seq { tx.execute(PRUNE,[seq]).map_err(AppStorageError::sqlite)?; }
        tx.commit().map_err(AppStorageError::sqlite)
    }).await.map_err(app_error)
}
