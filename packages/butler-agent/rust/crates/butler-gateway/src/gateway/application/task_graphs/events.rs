//! Durable SSE invalidation only when the user-facing graph revision changes.
use super::super::{AppApplication, AppTaskGraphQuery, events, service};
use super::*;
use butler_turn::btcc::TaskGraphScope as GraphScope;
use tokio::sync::broadcast::error::RecvError;
mod deltas;

pub(in crate::gateway::application) fn start_events(app: &AppApplication) {
    let Some(mut changes) = app.dependencies.subsessions.graph_changes() else {
        return;
    };
    let port = app.dependencies.subsessions.clone();
    let storage = app.storage.clone();
    let subscribers = app.subscribers.clone();
    let clock = app.dependencies.identity_clock.clone();
    let shutdown = app.dependencies.service_shutdown.clone();
    tokio::spawn(async move {
        let mut snapshots = BTreeMap::new();
        loop {
            let change =
                tokio::select! {()=shutdown.cancelled()=>return,change=changes.recv()=>change};
            let session = match change {
                Ok(session) => session,
                Err(RecvError::Closed) => return,
                Err(RecvError::Lagged(_)) => {
                    let subscribers = subscribers.clone();
                    let now = clock.now_iso();
                    let _ = storage
                        .execute(move |db| {
                            events::append(
                                db,
                                &subscribers,
                                "stream.reconcile_required",
                                None,
                                serde_json::Map::new(),
                                &now,
                            )
                        })
                        .await;
                    snapshots.clear();
                    continue;
                }
            };
            let query = AppTaskGraphQuery {
                scope: GraphScope::Session(session.clone()),
                revision: None,
                cursor: None,
                limit: usize::MAX,
                include_nodes: true,
            };
            let view = match port.task_graph_read(query).await {
                Ok(view) => view,
                Err(error) => {
                    butler_core::diagnostic!("[gateway] graph invalidation unavailable: {}", error);
                    continue;
                }
            };
            let mut payloads = Vec::new();
            for graph in view["graphs"].as_array().into_iter().flatten() {
                if let Some(payload) = deltas::changes(graph, &session, &mut snapshots) {
                    payloads.push(payload);
                }
            }
            if payloads.is_empty() {
                continue;
            }
            let subscribers = subscribers.clone();
            let now = clock.now_iso();
            let result=storage.execute(move |db| {
                for mut payload in payloads {
                    let seq:i64=db.query_row("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0)+1",[],|r|r.get(0)).map_err(super::super::storage::AppStorageError::sqlite)?;
                    payload["event_seq"]=json!(seq);
                    events::append(db,&subscribers,"work_model.changed",None,service::map(&payload)?,&now)?;
                }
                Ok(())
            }).await;
            if result.is_err() {
                snapshots.clear();
            }
        }
    });
}
