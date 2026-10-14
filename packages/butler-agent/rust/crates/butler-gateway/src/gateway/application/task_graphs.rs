//! User-facing projection of existing plan actions and delegation groups.
mod events;
mod nodes;
mod response;
use super::AppSettingsFacts;
use butler_turn::btcc::{
    TaskGraphChildRecord as ChildRecord, TaskGraphRecords as GraphRecords,
    encode_task_graph_id as encode,
};
pub(super) use events::start_events;
pub use response::task_graph_response;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Shared public-text policy; preserve the author's words and language.
pub fn task_graph_label(raw: &str) -> String {
    butler_core::public_text::sanitize_public_text(raw, "")
}
pub fn task_graph_model_label(raw: &str) -> String {
    task_graph_label(raw)
}

/// One delegated objective is represented by its executing child's graph.
fn represented_by_steward_child(work: &butler_turn::btcc::TaskGraphWorkRecord) -> bool {
    work.execution_mode.as_deref() == Some("steward") && work.has_planned_steward
}

pub fn project_task_graphs(
    records: GraphRecords,
    times: &Value,
    facts: &AppSettingsFacts,
) -> Vec<Value> {
    let mut children: BTreeMap<String, Vec<ChildRecord>> = BTreeMap::new();
    for child in records.children {
        if let Some(work) = child
            .packet
            .pointer("/parent_work_ref/work_id")
            .and_then(Value::as_str)
        {
            children.entry(work.to_owned()).or_default().push(child);
        }
    }
    let reviews: BTreeMap<_, _> = records
        .reviews
        .into_iter()
        .map(|r| (r.work_id.clone(), r))
        .collect();
    let mut graphs = Vec::new();
    for work in records.works {
        if represented_by_steward_child(&work) {
            continue;
        }
        let assigned = children.remove(&work.id).unwrap_or_default();
        let review = reviews.get(&work.id);
        let nodes = nodes::work_nodes(&work, &assigned, review, times, facts);
        graphs.push(finish(&work, nodes, review));
    }
    graphs.sort_by_key(|graph| state_order(&graph["state"]));
    graphs
}

fn finish(
    work: &butler_turn::btcc::TaskGraphWorkRecord,
    mut nodes: Vec<Value>,
    review: Option<&butler_turn::btcc::TaskGraphReviewRecord>,
) -> Value {
    let keys: BTreeMap<&str, &str> = nodes
        .iter()
        .filter_map(|n| Some((n["_key"].as_str()?, n["task_id"].as_str()?)))
        .collect();
    let mut edges = Vec::new();
    for node in &nodes {
        for key in node["_deps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(from) = keys.get(key) {
                edges.push(json!({"from":from,"to":node["task_id"]}));
            }
        }
    }
    nodes::rank_nodes(&mut nodes, &edges);
    let counts = counts(&nodes);
    let state = graph_state(&work.status, &counts);
    let updated = nodes
        .iter()
        .flat_map(|n| n["attempts"].as_array().into_iter().flatten())
        .filter_map(|a| a["finished_at"].as_str().or(a["started_at"].as_str()))
        .chain([work.updated_at.as_str()])
        .max()
        .unwrap_or(&work.updated_at);
    let title = work
        .delegated_objective
        .as_deref()
        .unwrap_or(&work.objective);
    let mut graph = json!({"graph_id":encode("work:",&work.id,""),"title":task_graph_label(title),"state":state,
        "phase":work.phase,"work_state":work.status,"counts":counts,"nodes":nodes,"edges":edges,"updated_at":updated});
    let revision = digest(&json!([graph, work.source_revision, review.map(|r| &r.id)]).to_string());
    graph["graph_revision"] = json!(revision);
    if let Some(nodes) = graph["nodes"].as_array_mut() {
        for node in nodes {
            node["document"]["revision"] = json!(revision);
        }
    }
    graph
}

fn counts(nodes: &[Value]) -> Value {
    let mut counts = json!({"total":nodes.len(),"completed":0,"skipped":0,"running":0,"failed":0,"blocked":0,"cancelled":0});
    for node in nodes {
        let key = match node["status"].as_str().unwrap_or("") {
            "done" => "completed",
            "review" => "running",
            key => key,
        };
        if let Some(value) = counts.get_mut(key) {
            *value = json!(value.as_u64().unwrap_or(0) + 1);
        }
    }
    counts
}
fn graph_state(work_state: &str, counts: &Value) -> &'static str {
    match work_state {
        "completed" => "done",
        "abandoned" => "cancelled",
        "blocked" => "waiting",
        _ if counts["running"].as_u64().unwrap_or(0) > 0 => "running",
        _ if counts["failed"].as_u64().unwrap_or(0) > 0 => "failed",
        _ if counts["completed"].as_u64().unwrap_or(0)
            + counts["skipped"].as_u64().unwrap_or(0)
            == counts["total"].as_u64().unwrap_or(0) =>
        {
            "done"
        }
        _ => "waiting",
    }
}

fn state_order(state: &Value) -> u8 {
    match state.as_str() {
        Some("running") => 0,
        Some("failed") => 1,
        Some("waiting") => 2,
        Some("done") => 3,
        _ => 4,
    }
}

fn digest(value: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

/// Capture the SSE watermark before reading: a concurrent change remains replayable.
pub(super) fn read(
    app: &super::AppApplication,
    query: super::AppTaskGraphQuery,
) -> crate::gateway::ApplicationFuture<Value> {
    let owner = app.clone_handle();
    let storage = app.storage.clone();
    let port = app.dependencies.subsessions.clone();
    Box::pin(async move {
        let mut query = query;
        if let butler_turn::btcc::TaskGraphScope::Session(chat) = &mut query.scope
            && !chat.starts_with("butler/")
            && !chat.starts_with("worker-")
            && !chat.starts_with("steward-")
        {
            *chat = owner.runtime_hint(chat).await?;
        }
        let seq: u64 = storage
            .execute(|db| {
                db.query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |r| r.get(0))
                    .map_err(super::storage::AppStorageError::sqlite)
            })
            .await
            .map_err(super::app_error)?;
        let mut view = port.task_graph_read(query).await?;
        if view.get("event_seq").is_some() {
            view["event_seq"] = json!(seq);
        }
        Ok(view)
    })
}
