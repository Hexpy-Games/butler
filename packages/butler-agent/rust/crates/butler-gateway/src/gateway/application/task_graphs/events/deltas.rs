//! Full public node patches; cached snapshots are used only for event diffs.
use super::*;

pub(super) struct GraphState {
    revision: String,
    nodes: BTreeMap<String, Value>,
}

pub(super) fn changes(
    graph: &Value,
    session: &str,
    snapshots: &mut BTreeMap<String, GraphState>,
) -> Option<Value> {
    let id = graph["graph_id"].as_str()?;
    let revision = graph["graph_revision"].as_str()?;
    if snapshots.get(id).is_some_and(|s| s.revision == revision) {
        return None;
    }
    let nodes: BTreeMap<String, Value> = graph["nodes"]
        .as_array()?
        .iter()
        .filter_map(|node| Some((node["task_id"].as_str()?.to_owned(), node.clone())))
        .collect();
    let previous = snapshots.remove(id);
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
        "counts":graph["counts"],"updated_at":graph["updated_at"]});
    snapshots.insert(
        id.to_owned(),
        GraphState {
            revision: revision.to_owned(),
            nodes,
        },
    );
    Some(payload)
}
