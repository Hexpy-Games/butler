//! One owning Work graph retains every Steward attempt's action nodes.
use super::*;
use butler_turn::btcc::{TaskGraphReviewRecord as ReviewRecord, TaskGraphWorkRecord as WorkRecord};

pub(super) fn graphs(
    works: &[WorkRecord],
    children: &mut BTreeMap<String, Vec<ChildRecord>>,
    reviews: &BTreeMap<String, ReviewRecord>,
    times: &Value,
    facts: &AppSettingsFacts,
) -> Vec<Value> {
    let parents: BTreeMap<_, _> = children
        .iter()
        .flat_map(|(parent, attempts)| {
            attempts
                .iter()
                .filter(|c| c.packet["child_role"] == "steward")
                .map(move |c| (c.session_id.clone(), parent.clone()))
        })
        .collect();
    let by_id: BTreeMap<_, _> = works.iter().map(|w| (w.id.as_str(), w)).collect();
    let mut grouped: BTreeMap<&str, Vec<&WorkRecord>> = BTreeMap::new();
    let mut order = Vec::new();
    for work in works {
        let mut owner = work;
        let mut seen = std::collections::BTreeSet::new();
        while seen.insert(&owner.id) {
            let Some(parent) = parents
                .get(&owner.session_id)
                .and_then(|id| by_id.get(id.as_str()))
            else {
                break;
            };
            owner = parent;
        }
        if !grouped.contains_key(owner.id.as_str()) {
            order.push(owner.id.as_str());
        }
        grouped.entry(&owner.id).or_default().push(work);
    }
    order
        .into_iter()
        .map(|id| project_group(by_id[id], &grouped[id], children, reviews, times, facts))
        .collect()
}

fn project_group(
    owner: &WorkRecord,
    members: &[&WorkRecord],
    children: &mut BTreeMap<String, Vec<ChildRecord>>,
    reviews: &BTreeMap<String, ReviewRecord>,
    times: &Value,
    facts: &AppSettingsFacts,
) -> Value {
    let mut nodes = Vec::new();
    for work in members {
        if work.execution_mode.as_deref() == Some("steward") && work.has_planned_steward {
            continue;
        }
        let assigned = children.remove(&work.id).unwrap_or_default();
        let mut actions = nodes::work_nodes(work, &assigned, reviews.get(&work.id), times, facts);
        settle_terminal_nodes(&work.status, &mut actions);
        namespace(&work.id, &mut actions);
        nodes.extend(actions);
    }
    let mut graph = finish(owner, nodes, reviews.get(&owner.id));
    if let Some(executing) = members.iter().rev().find(|w| w.id != owner.id) {
        graph["title"] = json!(task_graph_label(
            executing
                .delegated_objective
                .as_deref()
                .unwrap_or(&owner.objective)
        ));
        graph["phase"] = json!(executing.phase);
        if matches!(owner.status.as_str(), "open" | "blocked") {
            graph["work_state"] = json!(executing.status);
            graph["state"] = json!(graph_state(&executing.status, &graph["counts"]));
        }
    }
    if let Some(updated) = members
        .iter()
        .map(|w| w.updated_at.as_str())
        .chain(graph["updated_at"].as_str())
        .max()
    {
        graph["updated_at"] = json!(updated);
    }
    // Every member revision participates, including plans with no action nodes.
    let sources: Vec<_> = members.iter().map(|w| &w.source_revision).collect();
    let revision = json!(digest(&json!([graph, sources]).to_string()));
    graph["graph_revision"] = revision.clone();
    if let Some(nodes) = graph["nodes"].as_array_mut() {
        for node in nodes {
            node["document"]["revision"] = revision.clone();
        }
    }
    graph
}

fn namespace(work: &str, nodes: &mut [Value]) {
    for node in nodes {
        node["_key"] = json!(format!("{work}:{}", node["_key"].as_str().unwrap_or("")));
        node["_deps"] = json!(
            node["_deps"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|key| format!("{work}:{key}"))
                .collect::<Vec<_>>()
        );
    }
}

pub(super) fn settle_terminal_nodes(status: &str, nodes: &mut [Value]) {
    let terminal = match status {
        "abandoned" => "cancelled",
        "completed" => "done",
        _ => return,
    };
    for node in nodes {
        if !matches!(
            node["status"].as_str(),
            Some("done" | "skipped" | "cancelled")
        ) {
            node["status"] = json!(terminal);
            node["document"]["status"] = json!(terminal);
            node["current_step"] = Value::Null;
            node["reason_code"] = json!(if status == "abandoned" {
                "work_abandoned"
            } else {
                "work_completed"
            });
        }
        if let Some(attempts) = node["attempts"].as_array_mut() {
            for attempt in attempts {
                if matches!(attempt["status"].as_str(), Some("running" | "pending")) {
                    attempt["status"] = json!("cancelled");
                }
            }
        }
    }
}
