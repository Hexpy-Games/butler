use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::btcc::work::{ActionProgress, ActionStatus, PlanAction, WorkStage};

use super::{LegacyItem, StorageResult};

pub(in crate::btcc::storage) struct Projection {
    pub objective: String,
    pub original_message_id: Option<String>,
    pub actions: Vec<PlanAction>,
    pub checks: Vec<String>,
    pub checkpoint: Option<ProjectedCheckpoint>,
}

pub(in crate::btcc::storage) struct ProjectedCheckpoint {
    pub stage: WorkStage,
    pub actions: Vec<ActionProgress>,
    pub summary: String,
    pub next: String,
}

pub(super) fn project(
    goal: &Value,
    plan: &Value,
    works: &[LegacyItem],
    tasks: &[LegacyItem],
    mut read: impl FnMut(&str) -> StorageResult<Value>,
) -> StorageResult<Projection> {
    let objective = [field(goal, "request"), field(goal, "intendedResult")]
        .into_iter()
        .chain(works.iter().map(|item| field(&item.content, "outcome")))
        .chain([field(plan, "strategy")])
        .filter_map(|value| concise(value, 800))
        .next()
        .unwrap_or_else(|| "Continue the unfinished Butler work.".into());
    let original_message_id = concise(field(goal, "originalMessageId"), 200);
    let sources = if tasks.is_empty() { works } else { tasks };
    let actions = project_actions(sources, !tasks.is_empty());
    let mut checks = Vec::new();
    for task in tasks {
        for reference in references(field(&task.content, "criterionRefs")) {
            let criterion = read(&reference)?;
            if let Some(statement) = concise(field(&criterion, "statement"), 300)
                && !checks.contains(&statement)
            {
                checks.push(statement);
            }
            if checks.len() >= 16 {
                break;
            }
        }
        if checks.len() >= 16 {
            break;
        }
    }
    if checks.len() < 16
        && let Some(acceptance) = concise(field(goal, "acceptanceIntent"), 300)
        && !checks.contains(&acceptance)
    {
        checks.push(acceptance);
    }
    let checkpoint = if tasks.is_empty() {
        None
    } else {
        let accepted = tasks
            .iter()
            .filter(|task| task.status == "accepted")
            .count();
        let current = tasks.iter().position(|task| task.status != "accepted");
        let next = current
            .and_then(|index| actions.get(index))
            .map(|action| action.description.clone())
            .unwrap_or_else(|| "Review the imported work against the current request.".into());
        Some(ProjectedCheckpoint {
            stage: WorkStage::Execution,
            actions: actions
                .iter()
                .enumerate()
                .map(|(index, action)| ActionProgress {
                    action_key: action.action_key.clone(),
                    status: if tasks
                        .get(index)
                        .is_some_and(|task| task.status == "accepted")
                    {
                        ActionStatus::Done
                    } else {
                        ActionStatus::Pending
                    },
                    note: None,
                })
                .collect(),
            summary: format!(
                "Imported prior progress: {accepted} of {} planned actions have recorded accepted results.",
                tasks.len()
            ),
            next,
        })
    };
    Ok(Projection {
        objective,
        original_message_id,
        actions,
        checks,
        checkpoint,
    })
}

fn project_actions(items: &[LegacyItem], tasks: bool) -> Vec<PlanAction> {
    let selected = &items[..items.len().min(20)];
    let mut keys = Vec::with_capacity(selected.len());
    let mut used = HashSet::new();
    for (index, item) in selected.iter().enumerate() {
        let field_name = if tasks {
            "taskLogicalId"
        } else {
            "workLogicalId"
        };
        let base = concise(field(&item.content, field_name), 80)
            .unwrap_or_else(|| format!("legacy-action-{}", index + 1));
        let mut key = base.clone();
        let mut suffix = 2;
        while used.contains(&key) {
            key = truncate_utf16(&format!("{base}-{suffix}"), 96);
            suffix += 1;
        }
        used.insert(key.clone());
        keys.push(key);
    }
    let mut refs = HashMap::new();
    for (item, key) in selected.iter().zip(&keys) {
        refs.insert(item.id.clone(), key.clone());
        if let Some(id) = reference(field(&item.content, "ref")) {
            refs.insert(id, key.clone());
        }
    }
    selected
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let title = concise(
                field(
                    &item.content,
                    if tasks {
                        "displayTitle"
                    } else {
                        "workLogicalId"
                    },
                ),
                160,
            );
            let outcome = concise(
                field(
                    &item.content,
                    if tasks { "intendedOutcome" } else { "outcome" },
                ),
                400,
            );
            let mut parts = Vec::new();
            if let Some(title) = title {
                parts.push(title);
            }
            if let Some(outcome) = outcome
                && !parts.contains(&outcome)
            {
                parts.push(outcome);
            }
            let description = if parts.is_empty() {
                format!("Continue imported action {}.", index + 1)
            } else {
                parts.join(": ")
            };
            let dependency_keys = references(field(
                &item.content,
                if tasks {
                    "dependencyTaskRefs"
                } else {
                    "dependencyWorkRefs"
                },
            ))
            .into_iter()
            .filter_map(|reference| refs.get(&reference).cloned())
            .collect();
            PlanAction {
                action_key: keys[index].clone(),
                description,
                dependency_keys,
                effect: None,
            }
        })
        .collect()
}

fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
    value
        .as_object()
        .and_then(|object| object.get(name))
        .unwrap_or(&Value::Null)
}

fn concise(value: &Value, limit: usize) -> Option<String> {
    let source = value.as_str()?;
    let mut normalized = String::with_capacity(source.len());
    let mut pending_space = false;
    for character in source.chars() {
        if js_whitespace(character) {
            pending_space = !normalized.is_empty();
        } else {
            if pending_space {
                normalized.push(' ');
                pending_space = false;
            }
            normalized.push(character);
        }
    }
    (!normalized.is_empty()).then(|| truncate_utf16(&normalized, limit))
}

fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= limit
        })
        .collect()
}

fn js_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}'..='\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn reference(value: &Value) -> Option<String> {
    concise(field(value, "id"), 300)
}

fn references(value: &Value) -> Vec<String> {
    value.as_array().map_or_else(Vec::new, |items| {
        items.iter().filter_map(reference).collect()
    })
}
