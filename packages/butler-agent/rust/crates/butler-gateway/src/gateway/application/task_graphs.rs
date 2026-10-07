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

/// Removes internal orchestration/tool vocabulary from user-visible copy.
pub fn task_graph_label(raw: &str) -> String {
    label(raw, true)
}
/// Catalog names are public labels, including names with underscores.
pub fn task_graph_model_label(raw: &str) -> String {
    label(raw, false)
}
fn label(raw: &str, scrub_tool_ids: bool) -> String {
    raw.split_whitespace()
        .map(|word| {
            let clean = word
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
                .to_lowercase();
            if [
                "work",
                "steward",
                "delegated",
                "delegation",
                "스튜어드",
                "위임",
            ]
            .iter()
            .any(|name| {
                clean
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|part| part == *name)
            }) || ["Work", "Steward"].iter().any(|role| {
                word.match_indices(*role).any(|(at, _)| {
                    word[at + role.len()..]
                        .chars()
                        .next()
                        .is_none_or(char::is_uppercase)
                })
            }) || word.contains("스튜어드")
                || (scrub_tool_ids
                    && clean.contains('_')
                    && (word.contains('(') || !word.contains(['.', '/'])))
            {
                "Task"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn project_task_graphs(
    records: GraphRecords,
    times: &Value,
    facts: &AppSettingsFacts,
) -> Vec<Value> {
    let mut children: BTreeMap<String, Vec<ChildRecord>> = BTreeMap::new();
    for child in records.children {
        let id = child
            .packet
            .pointer("/parent_work_ref/plan_revision_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| encode("group:", &child.parent_session, &child.parent_turn));
        children.entry(id).or_default().push(child);
    }
    let mut graphs = Vec::new();
    for plan in records.plans {
        let assigned = children.remove(&plan.id).unwrap_or_default();
        let nodes = nodes::plan_nodes(&plan, &assigned, times, facts);
        graphs.push(finish(&plan.id, &plan.objective, nodes, &plan.updated_at));
    }
    for (id, children) in children {
        let updated = children
            .iter()
            .map(|c| c.result_at.as_deref().unwrap_or(&c.created_at))
            .max()
            .unwrap_or("");
        let title = children.first().map_or("Tasks", |c| {
            c.packet
                .get("objective")
                .and_then(Value::as_str)
                .unwrap_or(&c.title)
        });
        let nodes = nodes::group_nodes(&children, times, facts);
        graphs.push(finish(&id, title, nodes, updated));
    }
    // Stable creation order within each state, even as progress timestamps change.
    graphs.sort_by_key(|graph| state_order(&graph["state"]));
    graphs
}

fn finish(id: &str, title: &str, mut nodes: Vec<Value>, updated: &str) -> Value {
    let keys: BTreeMap<String, String> = nodes
        .iter()
        .filter_map(|n| Some((n["_key"].as_str()?.into(), n["task_id"].as_str()?.into())))
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
    nodes::propagate_blocked(&mut nodes, &edges);
    let mut counts =
        json!({"total":nodes.len(),"completed":0,"running":0,"failed":0,"blocked":0,"cancelled":0});
    for node in &nodes {
        if let Some(status) = node["status"].as_str() {
            let status = if status == "in_review" {
                "running"
            } else {
                status
            };
            if let Some(value) = counts.get_mut(status) {
                *value = json!(value.as_u64().unwrap_or(0) + 1);
            }
        }
    }
    let state = if counts["running"].as_u64().unwrap_or(0) > 0 {
        "running"
    } else if counts["failed"].as_u64().unwrap_or(0) > 0 {
        "failed"
    } else if counts["cancelled"] == counts["total"] && !nodes.is_empty() {
        "cancelled"
    } else if counts["completed"].as_u64().unwrap_or(0) + counts["cancelled"].as_u64().unwrap_or(0)
        == counts["total"].as_u64().unwrap_or(0)
    {
        "done"
    } else {
        "waiting"
    };
    let updated = nodes
        .iter()
        .filter_map(|n| n["finished_at"].as_str().or(n["started_at"].as_str()))
        .chain([updated])
        .max()
        .unwrap_or(updated);
    let mut graph = json!({"graph_id":id,"title":task_graph_label(title),"state":state,"counts":counts,"nodes":nodes,"edges":edges,"updated_at":updated});
    let revision = digest(&graph.to_string());
    graph["graph_revision"] = json!(revision);
    if let Some(nodes) = graph["nodes"].as_array_mut() {
        for node in nodes {
            node["document"]["revision"] = json!(revision);
        }
    }
    graph
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
    let storage = app.storage.clone();
    let port = app.dependencies.subsessions.clone();
    Box::pin(async move {
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
