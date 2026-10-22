//! Durable, idempotent outbox bridge. Startup catch-up, then change signals only.
use super::*;
use crate::gateway::application::storage::AppStorageError;
use rusqlite::OptionalExtension;
use serde_json::json;

pub(in crate::gateway::application) fn start(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.work_model.changes() else {
        return;
    };
    let port = app.dependencies.work_model.clone();
    let storage = app.storage.clone();
    let subscribers = app.subscribers.clone();
    let clock = app.dependencies.identity_clock.clone();
    let shutdown = app.dependencies.service_shutdown.clone();
    tokio::spawn(async move {
        let init=storage.execute(|db|db.execute_batch("CREATE TABLE IF NOT EXISTS app_work_model_events(btcc_seq INTEGER PRIMARY KEY,event_id INTEGER NOT NULL)").map_err(AppStorageError::sqlite)).await;
        if init.is_err() {
            return;
        }
        let mut after = 0;
        loop {
            changes.borrow_and_update();
            if let Err(error) =
                drain(&port, &storage, &subscribers, clock.as_ref(), &mut after).await
            {
                butler_core::diagnostic!("[gateway] work-model events unavailable: {error}");
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
    port: &Arc<dyn AppWorkModelPort>,
    storage: &super::super::storage::AppStorage,
    subscribers: &EventSubscribers,
    clock: &dyn AppIdentityClock,
    after: &mut i64,
) -> Result<(), GatewayApplicationError> {
    loop {
        let rows = port.unpublished(*after).await?;
        if rows.is_empty() {
            return Ok(());
        }
        let last = rows.last().map(|r| r.seq).unwrap_or(*after);
        let seqs = rows.iter().map(|r| r.seq).collect();
        let subs = subscribers.clone();
        let now = clock.now_iso();
        storage.execute(move |db| {
            for row in rows {
                let exists=db.query_row("SELECT event_id FROM app_work_model_events WHERE btcc_seq=?1",[row.seq],|r|r.get::<_,i64>(0)).optional().map_err(AppStorageError::sqlite)?;
                if exists.is_some() { continue; }
                let mut payload=row.payload;
                let seq:i64=db.query_row("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)+1",[],|r|r.get(0)).map_err(AppStorageError::sqlite)?;
                if row.topic=="canon.changed" { payload["event_seq"]=json!(seq); }
                let event=super::super::events::append(db,&subs,&row.topic,None,service::map(&payload)?,&now)?;
                db.execute("INSERT INTO app_work_model_events(btcc_seq,event_id) VALUES(?1,?2)",rusqlite::params![row.seq,event.id]).map_err(AppStorageError::sqlite)?;
            }
            Ok(())
        }).await.map_err(app_error)?;
        port.published(seqs).await?;
        *after = last;
    }
}
