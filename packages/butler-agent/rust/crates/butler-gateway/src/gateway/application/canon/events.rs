//! Durable, idempotent outbox bridge. Startup catch-up, then change signals only.
use super::super::storage::schema::canon::{PRUNE, RECEIPT};
use super::*;
use crate::gateway::application::storage::AppStorageError;
use rusqlite::OptionalExtension;
use serde_json::json;

#[derive(Default)]
struct Cursor {
    after: i64,
    prune: Option<i64>,
    started: bool,
}

pub(in crate::gateway::application) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.canon.changes() else {
        return;
    };
    let port = app.dependencies.canon.clone();
    let storage = app.storage.clone();
    let subscribers = app.subscribers.clone();
    let clock = app.dependencies.identity_clock.clone();
    let shutdown = app.dependencies.service_shutdown.clone();
    let app = app.clone_handle();
    tokio::spawn(async move {
        #[cfg(feature = "e2e-fixtures")]
        if let Err(error) = super::hold(&app, "canon_relay_start").await {
            tracing::error!(%error, "Canon relay startup barrier failed");
            return;
        }
        let mut cursor = Cursor::default();
        loop {
            changes.borrow_and_update();
            let reconciliation = tokio::select! {
                () = shutdown.cancelled() => return,
                result = port.reconcile() => result,
            };
            if let Err(error) = reconciliation {
                tracing::warn!(%error, "Canon reconciliation failed; outbox drain continues");
            }
            // Catch up on startup, and retry one failed drain immediately, even
            // when idle. After that, only a change signal wakes us (no timer).
            for _ in 0..2 {
                let result = tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    result = drain(&app, &port, &storage, &subscribers, clock.as_ref(), &mut cursor) => result,
                };
                let Err(error) = result else {
                    break;
                };
                tracing::error!(%error, "Work model event drain failed");
                let subs = subscribers.clone();
                let now = clock.now_iso();
                let _ = storage
                    .execute(move |db| {
                        super::super::events::append(
                            db,
                            &subs,
                            "stream.reconcile_required",
                            None,
                            serde_json::Map::new(),
                            &now,
                        )
                    })
                    .await;
            }
            tokio::select! { ()=shutdown.cancelled()=>return, changed=changes.changed()=>if changed.is_err(){return;} }
        }
    });
}
async fn drain(
    app: &AppApplication,
    port: &Arc<dyn AppCanonPort>,
    storage: &super::super::storage::AppStorage,
    subscribers: &EventSubscribers,
    clock: &dyn AppIdentityClock,
    cursor: &mut Cursor,
) -> Result<(), GatewayApplicationError> {
    let mut files_ready = app.canon_file_lifetimes.lock().await;
    loop {
        // Keep a failed cleanup pending across the bounded drain retry too.
        if let Some(last) = cursor.prune {
            prune_receipts(storage, last).await?;
            cursor.prune = None;
        }
        let mut rows = port.unpublished(cursor.after).await?;
        for row in rows
            .iter_mut()
            .filter(|r| r.topic == "pending_asks.changed")
        {
            let owner = row.payload["session_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let authority = app
                .dependencies
                .authority_handoff
                .pending_asks(Some(owner), usize::MAX, None)
                .await?
                .len();
            row.payload["open_count"] =
                json!(row.payload["open_count"].as_u64().unwrap_or(0) + authority as u64);
        }
        if rows.is_empty() {
            // Apply the durable outbox before expiring unsaved uploads after a crash.
            super::files::sweep(app, !cursor.started).await?;
            cursor.started = true;
            *files_ready = true;
            return Ok(());
        }
        let last = rows.last().map(|r| r.seq).unwrap_or(cursor.after);
        let seqs = rows.iter().map(|r| r.seq).collect();
        let subs = subscribers.clone();
        let now = clock.now_iso();
        storage
            .execute(move |db| append_rows(db, &subs, &now, rows))
            .await
            .map_err(app_error)?;
        port.published(seqs).await?;
        // App append + receipt commit together. Keep receipts until BTCC has
        // durably acknowledged: replay after a crash cannot append twice.
        // A crash before App commit leaves no event or receipt. A crash after
        // that commit but before published() replays through the receipt.
        // After published() commits, pruning is safe: BTCC no longer returns
        // those rows. A failed prune is retried before advancing the drain.
        cursor.after = last;
        cursor.prune = Some(last);
    }
}

async fn prune_receipts(
    storage: &super::super::storage::AppStorage,
    last: i64,
) -> Result<(), GatewayApplicationError> {
    storage
        .execute(move |db| {
            db.execute(PRUNE, [last]).map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .map_err(app_error)
}

fn append_rows(
    db: &rusqlite::Connection,
    subscribers: &EventSubscribers,
    now: &str,
    rows: Vec<AppCanonEvent>,
) -> Result<(), AppStorageError> {
    for row in rows {
        let exists = db
            .query_row(RECEIPT, [row.seq], |r| r.get::<_, i64>(0))
            .optional()
            .map_err(AppStorageError::sqlite)?;
        if exists.is_some() {
            continue;
        }
        let mut payload = row.payload;
        super::public_sessions(db, &mut payload)?;
        super::files::replace(db, &payload)?;
        if row.topic == "canon.changed" {
            let seq: i64 = db
                .query_row(
                    "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)+1",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppStorageError::sqlite)?;
            payload["event_seq"] = json!(seq);
        }
        let event = super::super::events::append(
            db,
            subscribers,
            &row.topic,
            None,
            service::map(&payload)?,
            now,
        )?;
        db.execute(
            "INSERT INTO app_work_model_events(btcc_seq,event_id) VALUES(?1,?2)",
            rusqlite::params![row.seq, event.id],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
