//! Durable source outboxes, drained on change signals only (including startup).
use super::*;
use crate::gateway::application::{
    AppAuthorityHandoff, EventSubscribers, events as app_events, service,
};
use rusqlite::OptionalExtension;
use std::sync::Arc;

pub(crate) const CURSOR: &str = "SELECT seq FROM app_pending_ask_cursor WHERE id=1";
pub(crate) const ADVANCE: &str = "UPDATE app_pending_ask_cursor SET seq=?1 WHERE id=1";

pub(in crate::gateway::application) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.authority_handoff.pending_ask_signal() else {
        return;
    };
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
                row.seq,
            )
            .await?;
            port.ack_pending_asks(row.seq).await?;
        }
    }
    Ok(())
}

async fn publish(
    app: &AppApplication,
    port: &Arc<dyn AppAuthorityHandoff>,
    chat: &str,
    id: &str,
    kind: &str,
    state: &str,
    authority_seq: i64,
) -> Result<(), GatewayApplicationError> {
    let owner = app.runtime_hint(chat).await?;
    let mut count = port
        .pending_asks(Some(owner.clone()), usize::MAX, None)
        .await?
        .len();
    let canon = app
        .dependencies
        .canon
        .proposal("open".into(), json!({"session_id":owner,"limit":201}))
        .await?;
    count += canon.as_array().map_or(0, Vec::len);
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
        let visible: Option<bool> = tx.query_row(CHAT,[&chat],|r|r.get(1)).optional().map_err(AppStorageError::sqlite)?;
        let open_count = if visible==Some(false) { count } else { 0 };
        app_events::append(&tx,&subscribers,"pending_asks.changed",None,service::map(&json!({"session_id":chat,"ask_id":id,"kind":kind,"state":state,"open_count":open_count}))?,&now)?;
        tx.execute(ADVANCE,[authority_seq]).map_err(AppStorageError::sqlite)?;
        tx.commit().map_err(AppStorageError::sqlite)
    }).await.map_err(app_error)
}
