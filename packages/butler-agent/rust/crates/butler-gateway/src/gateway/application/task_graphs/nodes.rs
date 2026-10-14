//! Stable Work/action identity. Attempt outcomes never finish owning actions.
use super::*;
use butler_turn::btcc::{TaskGraphReviewRecord as ReviewRecord, TaskGraphWorkRecord as WorkRecord};
use std::collections::{HashMap, VecDeque};

pub(super) fn work_nodes(
    work: &WorkRecord,
    children: &[ChildRecord],
    review: Option<&ReviewRecord>,
    times: &Value,
    facts: &AppSettingsFacts,
) -> Vec<Value> {
    let mut attempts: HashMap<&str, Vec<&ChildRecord>> = HashMap::new();
    for child in children {
        if let Some(key) = child
            .packet
            .pointer("/plan_action/action_key")
            .and_then(Value::as_str)
        {
            attempts.entry(key).or_default().push(child);
        }
    }
    let progress: HashMap<&str, &Value> = work
        .progress
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["actionKey"].as_str()?, p)))
        .collect();
    let review_view = review.map(public_review);
    let checks = safe_strings(&work.checks);
    let refs = safe_strings(&work.refs);
    work.actions.as_array().into_iter().flatten().map(|action| {
        let key = action["actionKey"].as_str().unwrap_or("");
        let assigned = attempts.get(key).map_or(&[][..], Vec::as_slice);
        let direct = work.execution_mode.as_deref()==Some("direct");
        let child = if direct { None } else { assigned.last().copied() };
        let state = progress.get(key).copied().unwrap_or(&Value::Null);
        let (status, reason) = status(work,state,child,review,times);
        let id = encode("task:",&work.id,key);
        let title = task_graph_label(action["description"].as_str().unwrap_or(""));
        let history: Vec<Value> = assigned.iter().map(|c| attempt(c,times,facts)).collect();
        let latest = if direct { &Value::Null } else { history.last().unwrap_or(&Value::Null) };
        let note = match reason { Some("action_blocked") => state["note"].as_str(),
            Some("attempt_failed") => child.and_then(|c| c.result_summary.as_deref()), _ => None };
        let mut node = json!({"task_id":id,"title":title,"status":status,"kind":"task","rank":0,
            "assignee_ordinal":child.map(|c|c.ordinal),"handled_directly":direct,
            "model_display_name":latest["model_display_name"],"session_id":child.map(|c|c.session_id.as_str()).or(direct.then_some(work.session_id.as_str())),
            "started_at":latest["started_at"],"finished_at":latest["finished_at"],
            "current_step":if matches!(status,"running"|"review") {child.and_then(|c| c.current_step.as_deref()).or(direct.then_some(work.next_step.as_deref()).flatten()).map(task_graph_label)}else{None},
            "blocked_reason":note.map(task_graph_label),"reason_code":reason,"attempts":history,
            "document":{"id":id,"revision":null,"title":title,"status":status,"source_label":"Task document"},
            "_key":key,"_deps":action["dependencyKeys"],"_goal":title,"_checks":checks,"_refs":refs});
        if let Some(review) = &review_view { node["review"] = review.clone(); }
        node
    }).collect()
}

fn status(
    work: &WorkRecord,
    progress: &Value,
    child: Option<&ChildRecord>,
    review: Option<&ReviewRecord>,
    times: &Value,
) -> (&'static str, Option<&'static str>) {
    match progress["status"].as_str() {
        Some("done") => return ("done", None),
        _ if work.status == "abandoned" => return ("cancelled", Some("work_abandoned")),
        Some("skipped") => return ("skipped", None),
        Some("blocked") => return ("blocked", Some("action_blocked")),
        Some("active") => {}
        _ => return ("pending", None),
    }
    let Some(child) = child else {
        return ("running", None);
    };
    let revised = review.is_some_and(|r| {
        r.subject != "plan"
            && matches!(r.verdict.as_str(), "revise" | "partial")
            && child.result_status.is_some()
            && newer(Some(&r.created_at), child.result_at.as_deref())
    });
    if revised {
        return ("pending", Some("review_revised"));
    }
    let handled = newer(work.checkpoint_at.as_deref(), child.result_at.as_deref())
        || review.is_some_and(|r| newer(Some(&r.created_at), child.result_at.as_deref()));
    if child.result_status.is_some() && !handled {
        return if matches!(child.result_status.as_deref(), Some("failed" | "cancelled")) {
            ("failed", Some("attempt_failed"))
        } else {
            ("review", Some("result_received"))
        };
    }
    let lifecycle = &times[&child.turn_id];
    if child.result_status.is_none()
        && (matches!(child.turn_state.as_deref(), Some("failed" | "cancelled"))
            || matches!(
                lifecycle["status"].as_str(),
                Some("failed" | "cancelled" | "runtime_fault")
            ))
    {
        return ("failed", Some("attempt_failed"));
    }
    ("running", None)
}

fn newer(left: Option<&str>, right: Option<&str>) -> bool {
    left.zip(right).is_some_and(|(a, b)| {
        chrono::DateTime::parse_from_rfc3339(a)
            .ok()
            .zip(chrono::DateTime::parse_from_rfc3339(b).ok())
            .is_some_and(|(a, b)| a > b)
    })
}
fn attempt(child: &ChildRecord, times: &Value, facts: &AppSettingsFacts) -> Value {
    let lifecycle = &times[&child.turn_id];
    let model = child.packet["model_ref"]
        .as_str()
        .and_then(|id| {
            facts
                .native_settings
                .get("model_display_names")?
                .get(id)?
                .as_str()
        })
        .map(task_graph_model_label);
    let status = child.result_status.as_deref().unwrap_or_else(|| {
        if child.turn_state.as_deref() == Some("admitted") || lifecycle["status"] == "running" {
            "running"
        } else {
            "pending"
        }
    });
    json!({"task_id":child.task_id,"session_id":child.session_id,"ordinal":child.ordinal,"status":status,
        "summary":child.result_summary.as_deref().map(task_graph_label),"model_display_name":model,
        "started_at":lifecycle["started_at"].as_str().unwrap_or(&child.created_at),
        "finished_at":lifecycle["finished_at"].as_str().or(child.result_at.as_deref())})
}
pub(super) fn public_review(review: &ReviewRecord) -> Value {
    json!({"subject":review.subject,"verdict":review.verdict,"summary":task_graph_label(&review.summary),"created_at":review.created_at})
}
fn safe_strings(value: &Value) -> Value {
    json!(
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(task_graph_label)
            .collect::<Vec<_>>()
    )
}

/// Longest-path rank only. Dependency failure never mutates a BTCC action.
pub(super) fn rank_nodes(nodes: &mut [Value], edges: &[Value]) {
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
            nodes[b]["rank"] = json!(
                nodes[b]["rank"]
                    .as_u64()
                    .unwrap_or(0)
                    .max(nodes[a]["rank"].as_u64().unwrap_or(0) + 1)
            );
            remaining[b] -= 1;
            if remaining[b] == 0 {
                queue.push_back(b);
            }
        }
    }
}
