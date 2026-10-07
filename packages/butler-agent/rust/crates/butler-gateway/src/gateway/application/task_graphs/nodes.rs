//! Node identity, dependency mapping and safe lifecycle projection.
use super::*;
use butler_turn::btcc::TaskGraphPlanRecord as PlanRecord;
use std::collections::{HashMap, VecDeque};

pub(super) fn plan_nodes(
    plan: &PlanRecord,
    children: &[ChildRecord],
    times: &Value,
    facts: &AppSettingsFacts,
) -> Vec<Value> {
    let assigned: HashMap<&str, &ChildRecord> = children
        .iter()
        .filter_map(|c| Some((c.packet.pointer("/plan_action/action_key")?.as_str()?, c)))
        .collect();
    let progress: HashMap<&str, &str> = plan
        .progress
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some((
                p.get("actionKey").or(p.get("action_key"))?.as_str()?,
                p["status"].as_str()?,
            ))
        })
        .collect();
    plan.actions
        .as_array()
        .into_iter()
        .flatten()
        .map(|action| {
            let key = action
                .get("actionKey")
                .or(action.get("action_key"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let child = assigned.get(key).copied();
            let id = child.map_or_else(|| encode("task:", &plan.id, key), |c| c.task_id.clone());
            let mut node = base_node(
                &id,
                action["description"].as_str().unwrap_or("Task"),
                child,
                times,
                facts,
            );
            node["_key"] = json!(key);
            node["_deps"] = action
                .get("dependencyKeys")
                .or(action.get("dependency_keys"))
                .cloned()
                .unwrap_or(json!([]));
            node["_checks"] = child
                .and_then(|c| c.packet.get("acceptance_criteria"))
                .filter(|criteria| criteria.as_array().is_some_and(|items| !items.is_empty()))
                .cloned()
                .unwrap_or_else(|| plan.checks.clone());
            node["_refs"] = plan.refs.clone();
            if child.is_none() {
                node["status"] = json!(match progress.get(key).copied() {
                    _ if plan.status == "abandoned" => "cancelled",
                    Some("done") => "completed",
                    Some("active" | "in_progress") => "running",
                    Some("blocked") => "blocked",
                    Some("skipped") => "cancelled",
                    _ if plan.status == "completed" => "completed",
                    _ => "pending",
                });
            }
            node["document"]["status"] = node["status"].clone();
            node
        })
        .collect()
}

pub(super) fn group_nodes(
    children: &[ChildRecord],
    times: &Value,
    facts: &AppSettingsFacts,
) -> Vec<Value> {
    children
        .iter()
        .map(|child| {
            let mut node = base_node(&child.task_id, &child.title, Some(child), times, facts);
            node["_goal"] = child
                .packet
                .get("objective")
                .cloned()
                .unwrap_or(json!(child.title));
            node["_key"] = child
                .packet
                .pointer("/plan_action/action_key")
                .cloned()
                .unwrap_or(json!(child.task_id));
            node["_deps"] = child
                .packet
                .pointer("/plan_action/dependency_keys")
                .cloned()
                .unwrap_or(json!([]));
            node["_checks"] = child
                .packet
                .get("acceptance_criteria")
                .cloned()
                .unwrap_or(json!([]));
            node["_refs"] = child
                .packet
                .get("task_or_plan_refs")
                .cloned()
                .unwrap_or(json!([]));
            node
        })
        .collect()
}

fn base_node(
    id: &str,
    title: &str,
    child: Option<&ChildRecord>,
    times: &Value,
    facts: &AppSettingsFacts,
) -> Value {
    let goal = title;
    let title = task_graph_label(title);
    let lifecycle = child.map(|c| &times[&c.turn_id]).unwrap_or(&Value::Null);
    let status = match child.and_then(|c| c.result_status.as_deref()) {
        Some("success") => "completed",
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        Some("blocked") => "blocked",
        _ if lifecycle["status"] == "cancelled" => "cancelled",
        _ if lifecycle["status"] == "failed" || lifecycle["status"] == "runtime_fault" => "failed",
        _ if child.is_some_and(|c| c.turn_state.as_deref() == Some("admitted"))
            || lifecycle["status"] == "running" =>
        {
            "running"
        }
        _ => "pending",
    };
    let status =
        if status == "running" && child.is_some_and(|c| c.stage.as_deref() == Some("review")) {
            "in_review"
        } else {
            status
        };
    let model = child
        .and_then(|c| c.packet.get("model_ref"))
        .and_then(Value::as_str)
        .and_then(|id| {
            facts
                .native_settings
                .get("model_display_names")?
                .get(id)?
                .as_str()
        })
        .map(task_graph_model_label);
    let finished = lifecycle["finished_at"]
        .as_str()
        .or(child.and_then(|c| c.result_at.as_deref()));
    json!({"task_id":id,"_goal":goal,"title":title,"status":status,"kind":"task","rank":0,
        "assignee_ordinal":child.map(|c|c.ordinal),"model_display_name":model,
        "session_id":child.map(|c|&c.session_id),"started_at":lifecycle["started_at"],
        "finished_at":finished,"current_step":child.and_then(|c|c.current_step.as_deref()).filter(|_|matches!(status,"running"|"in_review")).map(task_graph_label),
        "blocked_reason":match status {"failed"=>Some("Task failed."),"blocked"=>Some("Task is blocked."),_=>None},
        "document":{"id":id,"revision":null,"title":title,"status":status,"source_label":"Task document"}})
}

pub(super) fn propagate_blocked(nodes: &mut [Value], edges: &[Value]) {
    let ids: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| Some((n["task_id"].as_str()?.into(), i)))
        .collect();
    let mut remaining = vec![0; nodes.len()];
    let mut next = vec![Vec::new(); nodes.len()];
    for edge in edges {
        if let (Some(a), Some(b)) = (
            edge["from"].as_str().and_then(|id| ids.get(id)),
            edge["to"].as_str().and_then(|id| ids.get(id)),
        ) {
            next[*a].push(*b);
            remaining[*b] += 1;
        }
    }
    let mut queue: VecDeque<usize> = remaining
        .iter()
        .enumerate()
        .filter_map(|(i, n)| (*n == 0).then_some(i))
        .collect();
    while let Some(a) = queue.pop_front() {
        for &b in &next[a] {
            let rank = nodes[a]["rank"].as_u64().unwrap_or(0) + 1;
            nodes[b]["rank"] = json!(nodes[b]["rank"].as_u64().unwrap_or(0).max(rank));
            if matches!(
                nodes[a]["status"].as_str(),
                Some("failed" | "cancelled" | "blocked")
            ) && nodes[b]["status"] == "pending"
            {
                nodes[b]["status"] = json!("blocked");
                nodes[b]["blocked_reason"] = json!("A prerequisite did not finish.");
                nodes[b]["document"]["status"] = json!("blocked");
            }
            remaining[b] -= 1;
            if remaining[b] == 0 {
                queue.push_back(b);
            }
        }
    }
    for (i, left) in remaining.into_iter().enumerate() {
        if left > 0 && nodes[i]["status"] == "pending" {
            nodes[i]["status"] = json!("blocked");
            nodes[i]["blocked_reason"] = json!("Task dependencies need review.");
            nodes[i]["document"]["status"] = json!("blocked");
        }
    }
}
