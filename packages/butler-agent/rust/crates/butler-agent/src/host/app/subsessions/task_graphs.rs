//! Host joins canonical lifecycle and cached model labels without N+1 reads.
use super::*;
use butler_gateway::gateway::{
    AppSettingsFactsProvider, AppTaskGraphQuery, project_task_graphs, task_graph_response,
};
use butler_turn::btcc::TaskGraphScope as GraphScope;

pub(super) fn read(
    host: &AppSubsessions,
    query: AppTaskGraphQuery,
) -> ApplicationFuture<serde_json::Value> {
    let repository = host.service.repository();
    let conversations = host.conversations.clone();
    let settings = host.settings.clone();
    Box::pin(async move {
        let mut scope = query.scope.clone();
        if let GraphScope::Session(id) = &mut scope
            && !id.starts_with("butler/")
            && !id.starts_with("worker-")
            && !id.starts_with("steward-")
        {
            *id = butler_gateway::gateway::app_session_hint(id);
        }
        let records = repository
            .graph_records(scope)
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        let ids = records.children.iter().map(|c| c.turn_id.clone()).collect();
        let times = conversations
            .read_turn_lifecycles(ids)
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        let facts = settings.snapshot()?;
        let graphs = project_task_graphs(records, &times, &facts);
        task_graph_response(graphs, &query)
    })
}

pub(super) fn changes(host: &AppSubsessions) -> tokio::sync::broadcast::Receiver<String> {
    let repository = host.service.repository();
    let mut signal = repository.graph_change_signal();
    let shutdown = host.shutdown.clone();
    let (sender, receiver) = tokio::sync::broadcast::channel(256);
    tokio::spawn(async move {
        let Ok(mut after) = repository.graph_change_watermark().await else {
            return;
        };
        loop {
            match repository.graph_changes_after(after).await {
                Ok(rows) => {
                    for (seq, session) in rows {
                        after = seq;
                        let _ = sender.send(session);
                    }
                }
                Err(error) => {
                    butler_core::diagnostic!(
                        "[gateway] graph changes unavailable: {}",
                        error.code()
                    );
                    return;
                }
            }
            tokio::select! {()=shutdown.cancelled()=>return,changed=signal.changed()=>if changed.is_err(){return;}}
        }
    });
    receiver
}
