use std::collections::{BTreeSet, HashMap};

use super::super::contracts::{ModelRoundMessage, ModelRoundRole};

const PLAN: &[&str] = &["replace_work_plan"];
const WORK: &[&str] = &[
    "start_work",
    "continue_work",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
];
const REVIEW: &[&str] = &["record_work_review"];

/// Indices of the latest successful plan, work and review tool results, which
/// replay keeps verbatim.
pub fn latest_work_anchor_indices(messages: &[ModelRoundMessage]) -> BTreeSet<usize> {
    let facts: Vec<_> = messages.iter().map(ModelRoundMessage::facts).collect();
    let mut calls: HashMap<&str, &str> = HashMap::new();
    for derived in &facts {
        for (id, name) in &derived.calls {
            calls.insert(id, name);
        }
    }
    let mut latest = [None, None, None];
    for (index, (message, derived)) in messages.iter().zip(&facts).enumerate() {
        if message.role != ModelRoundRole::Tool || !derived.succeeded {
            continue;
        }
        let name = message
            .tool_call_id
            .as_deref()
            .and_then(|id| calls.get(id).copied())
            .or(message.name.as_deref())
            .unwrap_or("");
        for (latest, tools) in latest.iter_mut().zip([PLAN, WORK, REVIEW]) {
            if tools.contains(&name) {
                *latest = Some(index);
            }
        }
    }
    latest.into_iter().flatten().collect()
}
