//! Full public node patches; cached snapshots are used only for event diffs.
use super::*;

pub(super) struct GraphState {
    revision: String,
    session: String,
    id: String,
    nodes: BTreeMap<String, Value>,
}

pub(super) fn changes(
    graph: &Value,
    session: &str,
    snapshots: &mut BTreeMap<String, GraphState>,
) -> Option<Value> {
    let id = graph["graph_id"].as_str()?;
    let revision = graph["graph_revision"].as_str()?;
    let cache_key = format!("{session}\0{id}");
    if snapshots
        .get(&cache_key)
        .is_some_and(|s| s.revision == revision)
    {
        return None;
    }
    let nodes: BTreeMap<String, Value> = graph["nodes"]
        .as_array()?
        .iter()
        .filter_map(|node| Some((node["task_id"].as_str()?.to_owned(), node.clone())))
        .collect();
    let previous = snapshots.remove(&cache_key);
    let mut entities = Vec::new();
    for (task_id, node) in &nodes {
        if previous.as_ref().and_then(|s| s.nodes.get(task_id)) != Some(node) {
            entities.push(json!({"type":"upsert","task_id":task_id,"node":node}));
        }
    }
    if let Some(previous) = &previous {
        for task_id in previous.nodes.keys().filter(|id| !nodes.contains_key(*id)) {
            entities.push(json!({"type":"remove","task_id":task_id}));
        }
    }
    let payload = json!({"session_id":session,"plan_id":id,"graph_revision":revision,
        "previous_graph_revision":previous.as_ref().map(|s|&s.revision),"refetch":previous.is_none(),
        "entity_changes":entities,"edges":graph["edges"],"title":graph["title"],"state":graph["state"],
        "counts":graph["counts"],"phase":graph["phase"],"work_state":graph["work_state"],
        "node_order":graph["nodes"].as_array()?.iter().map(|n|n["task_id"].clone()).collect::<Vec<_>>(),"updated_at":graph["updated_at"]});
    snapshots.insert(
        cache_key,
        GraphState {
            session: session.into(),
            id: id.into(),
            revision: revision.to_owned(),
            nodes,
        },
    );
    Some(payload)
}

/// A parent graph disappears when the child's plan starts representing it.
pub(super) fn remove_missing(
    graphs: &[Value],
    session: &str,
    snapshots: &mut BTreeMap<String, GraphState>,
) -> Vec<Value> {
    let present: std::collections::BTreeSet<_> = graphs
        .iter()
        .filter_map(|g| g["graph_id"].as_str())
        .collect();
    let removed: Vec<_> = snapshots
        .iter()
        .filter(|(_, s)| s.session == session && !present.contains(s.id.as_str()))
        .map(|(key, _)| key.clone())
        .collect();
    removed
        .into_iter()
        .filter_map(|key| snapshots.remove(&key))
        .map(|state| {
            json!({"session_id":session,"plan_id":state.id,"graph_revision":state.revision,
            "previous_graph_revision":state.revision,"removed":true,"refetch":false})
        })
        .collect()
}
