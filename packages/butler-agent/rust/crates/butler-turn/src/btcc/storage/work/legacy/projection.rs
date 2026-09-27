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

// Passthrough: legacy/historical records of unknown shape.
pub(super) fn project(
    // Passthrough: legacy/historical records of unknown shape.
    goal: &Value,
    // Passthrough: legacy/historical records of unknown shape.
    plan: &Value,
    works: &[LegacyItem],
    tasks: &[LegacyItem],
    mut read: impl FnMut(&str) -> StorageResult<Value>,
) -> StorageResult<Projection> {
    let objective = [field(goal, "request"), field(goal, "intendedResult")]
        .into_iter()
        .chain(works.iter().map(|item| field(&item.content, "outcome")))
        .chain([field(plan, "strategy")])
        .find_map(|value| concise(value, 800))
        .unwrap_or_else(|| "Continue the unfinished Butler work.".into());
    let original_message_id = concise(field(goal, "originalMessageId"), 200);
    let sources = if tasks.is_empty() { works } else { tasks };
    let kind = if tasks.is_empty() {
        LegacyItemKind::Work
    } else {
        LegacyItemKind::Task
    };
    let actions = project_actions(sources, kind);
    let checks = project_checks(goal, tasks, &mut read)?;
    let checkpoint = (!tasks.is_empty()).then(|| project_checkpoint(tasks, &actions));
    Ok(Projection {
        objective,
        original_message_id,
        actions,
        checks,
        checkpoint,
    })
}

/// Up to 16 distinct checks: the tasks' acceptance criteria, then the
/// goal's acceptance intent.
// Passthrough: legacy/historical records of unknown shape.
fn project_checks(
    // Passthrough: legacy/historical records of unknown shape.
    goal: &Value,
    tasks: &[LegacyItem],
    // Passthrough: legacy/historical records of unknown shape.
    read: &mut impl FnMut(&str) -> StorageResult<Value>,
) -> StorageResult<Vec<String>> {
    let mut checks = Vec::new();
    let criteria = tasks
        .iter()
        .flat_map(|task| references(field(&task.content, "criterionRefs")));
    for reference in criteria {
        if checks.len() >= 16 {
            break;
        }
        let criterion = read(&reference)?;
        if let Some(statement) = concise(field(&criterion, "statement"), 300)
            && !checks.contains(&statement)
        {
            checks.push(statement);
        }
    }
    if checks.len() < 16
        && let Some(acceptance) = concise(field(goal, "acceptanceIntent"), 300)
        && !checks.contains(&acceptance)
    {
        checks.push(acceptance);
    }
    Ok(checks)
}

/// The execution checkpoint of imported tasks: accepted tasks are done and
/// the first unaccepted one is next.
fn project_checkpoint(tasks: &[LegacyItem], actions: &[PlanAction]) -> ProjectedCheckpoint {
    let accepted = |task: &LegacyItem| task.status == "accepted";
    let next = tasks
        .iter()
        .position(|task| !accepted(task))
        .and_then(|index| actions.get(index))
        .map(|action| action.description.clone())
        .unwrap_or_else(|| "Review the imported work against the current request.".into());
    ProjectedCheckpoint {
        stage: WorkStage::Execution,
        actions: actions
            .iter()
            .enumerate()
            .map(|(index, action)| ActionProgress {
                action_key: action.action_key.clone(),
                status: if tasks.get(index).is_some_and(accepted) {
                    ActionStatus::Done
                } else {
                    ActionStatus::Pending
                },
                note: None,
            })
            .collect(),
        summary: format!(
            "Imported prior progress: {} of {} planned actions have recorded accepted results.",
            tasks.iter().filter(|task| accepted(task)).count(),
            tasks.len()
        ),
        next,
    }
}

/// Whether legacy plan actions come from task records or work records,
/// which name their fields differently.
#[derive(Clone, Copy)]
enum LegacyItemKind {
    Task,
    Work,
}

impl LegacyItemKind {
    fn key_field(self) -> &'static str {
        match self {
            Self::Task => "taskLogicalId",
            Self::Work => "workLogicalId",
        }
    }
    fn title_field(self) -> &'static str {
        match self {
            Self::Task => "displayTitle",
            Self::Work => "workLogicalId",
        }
    }
    fn outcome_field(self) -> &'static str {
        match self {
            Self::Task => "intendedOutcome",
            Self::Work => "outcome",
        }
    }
    fn dependencies_field(self) -> &'static str {
        match self {
            Self::Task => "dependencyTaskRefs",
            Self::Work => "dependencyWorkRefs",
        }
    }
}

/// The first 20 legacy items as plan actions with unique keys and
/// dependencies mapped to those keys.
fn project_actions(items: &[LegacyItem], kind: LegacyItemKind) -> Vec<PlanAction> {
    let selected = items.get(..items.len().min(20)).unwrap_or(items);
    let keys = unique_action_keys(selected, kind);
    let mut refs = HashMap::new();
    for (item, key) in selected.iter().zip(&keys) {
        refs.insert(item.id.clone(), key.clone());
        if let Some(id) = reference(field(&item.content, "ref")) {
            refs.insert(id, key.clone());
        }
    }
    selected
        .iter()
        .zip(keys)
        .enumerate()
        .map(|(index, (item, action_key))| PlanAction {
            action_key,
            description: action_description(item, kind, index),
            dependency_keys: references(field(&item.content, kind.dependencies_field()))
                .into_iter()
                .filter_map(|reference| refs.get(&reference).cloned())
                .collect(),
            effect: None,
        })
        .collect()
}

/// Logical ids (or positional keys) made unique with numeric suffixes.
fn unique_action_keys(items: &[LegacyItem], kind: LegacyItemKind) -> Vec<String> {
    let mut keys = Vec::with_capacity(items.len());
    let mut used = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let base = concise(field(&item.content, kind.key_field()), 80)
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
    keys
}

/// "title: outcome" (without repeating an identical outcome), or a
/// positional placeholder.
fn action_description(item: &LegacyItem, kind: LegacyItemKind, index: usize) -> String {
    let title = concise(field(&item.content, kind.title_field()), 160);
    let outcome = concise(field(&item.content, kind.outcome_field()), 400);
    let mut parts = Vec::new();
    if let Some(title) = title {
        parts.push(title);
    }
    if let Some(outcome) = outcome
        && !parts.contains(&outcome)
    {
        parts.push(outcome);
    }
    if parts.is_empty() {
        format!("Continue imported action {}.", index + 1)
    } else {
        parts.join(": ")
    }
}

// Passthrough: legacy/historical records of unknown shape.
fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
    value
        .as_object()
        .and_then(|object| object.get(name))
        .unwrap_or(&Value::Null)
}

// Passthrough: legacy/historical records of unknown shape.
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

// Passthrough: legacy/historical records of unknown shape.
fn reference(value: &Value) -> Option<String> {
    concise(field(value, "id"), 300)
}

// Passthrough: legacy/historical records of unknown shape.
fn references(value: &Value) -> Vec<String> {
    value.as_array().map_or_else(Vec::new, |items| {
        items.iter().filter_map(reference).collect()
    })
}
