use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::btcc::BtccError;
use crate::public_text::trim_js_whitespace;

const MUTATION_EFFECTS: &[&str] = &[
    "edit_file:workspace",
    "run_command:workspace",
    "write_file:workspace",
];
const READ_ONLY_EFFECTS: &[&str] = &[
    "grep_files:workspace",
    "list_files:workspace",
    "read_file:workspace",
    "web_read:network",
    "web_search:network",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubsessionExecutionMode {
    ReadOnly,
    Mutation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubsessionProjectContext {
    pub project_id: String,
    pub mandatory_hot_cache_refs: Vec<String>,
    pub optional_hot_cache_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubsessionMetadata {
    pub relation_id: String,
    pub delegation_id: String,
    pub task_id: String,
    pub execution_mode: SubsessionExecutionMode,
    pub mutation_scope: Vec<String>,
    pub allowed_tools_and_effects: Vec<String>,
    pub recent_feedback_refs: Vec<String>,
    pub project_context: Option<SubsessionProjectContext>,
}

pub(crate) fn read_subsession_metadata(
    value: Option<&Value>,
) -> Result<Option<SubsessionMetadata>, BtccError> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .filter(|value| !value.is_empty())
        .ok_or_else(invalid)?;
    let relation_id = optional_text(object, "relation_id").ok_or_else(invalid)?;
    let delegation_id = optional_text(object, "delegation_id").ok_or_else(invalid)?;
    let task_id = optional_text(object, "task_id").ok_or_else(invalid)?;
    let execution_mode = match object.get("execution_mode") {
        None => SubsessionExecutionMode::Mutation,
        Some(Value::String(value)) if value == "read_only" => SubsessionExecutionMode::ReadOnly,
        Some(Value::String(value)) if value == "mutation" => SubsessionExecutionMode::Mutation,
        _ => return Err(invalid()),
    };
    let effects = string_array(object.get("allowed_tools_and_effects"))?;
    let allowed_tools_and_effects = normalize_effects(effects, &execution_mode)?;
    let mutation_scope = match execution_mode {
        SubsessionExecutionMode::Mutation if file_scope_required(&allowed_tools_and_effects) => {
            normalize_scope(string_array(object.get("mutation_scope"))?)?
        }
        _ => Vec::new(),
    };
    Ok(Some(SubsessionMetadata {
        relation_id,
        delegation_id,
        task_id,
        execution_mode,
        mutation_scope,
        allowed_tools_and_effects,
        recent_feedback_refs: string_array(object.get("recent_feedback_refs"))?,
        project_context: read_project_context(object.get("project_context"))?,
    }))
}

fn normalize_effects(
    values: Vec<String>,
    mode: &SubsessionExecutionMode,
) -> Result<Vec<String>, BtccError> {
    let mut values = stable_unique(
        values
            .into_iter()
            .map(|value| trim_js_whitespace(&value).into()),
    )
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>();
    values.sort();
    if values.is_empty() {
        return Err(error("delegation_allowed_effects_required"));
    }
    let allowed = match mode {
        SubsessionExecutionMode::ReadOnly => READ_ONLY_EFFECTS,
        SubsessionExecutionMode::Mutation => MUTATION_EFFECTS,
    };
    if values
        .iter()
        .any(|value| !allowed.contains(&value.as_str()))
    {
        return Err(error("subsession_effect_not_allowed"));
    }
    if matches!(mode, SubsessionExecutionMode::ReadOnly) && values.len() != allowed.len() {
        return Err(error("subsession_read_only_surface_incomplete"));
    }
    Ok(values)
}

fn normalize_scope(values: Vec<String>) -> Result<Vec<String>, BtccError> {
    if values.is_empty() {
        return Err(error("delegation_mutation_scope_required"));
    }
    let mut paths = Vec::new();
    for value in values {
        let path = normalize_scope_path(&value)
            .ok_or_else(|| error("subsession_mutation_scope_invalid"))?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.sort();
    if paths
        .iter()
        .any(|value| ['*', '?', '[', ']'].iter().any(|ch| value.contains(*ch)))
    {
        return Err(error("subsession_mutation_scope_wildcard_not_allowed"));
    }
    Ok(paths)
}

fn normalize_scope_path(value: &str) -> Option<String> {
    let supplied = trim_js_whitespace(value).replace('\\', "/");
    if matches!(supplied.as_str(), "." | "./") {
        return Some(".".into());
    }
    let mut raw = supplied.strip_prefix("./").unwrap_or(&supplied).to_owned();
    while raw.contains("//") {
        raw = raw.replace("//", "/");
    }
    let subtree = raw.ends_with("/**");
    let directory = subtree || raw.ends_with('/');
    let body = if subtree { &raw[..raw.len() - 3] } else { &raw };
    let normalized = body.trim_end_matches('/');
    let invalid = normalized.is_empty()
        || normalized == "."
        || normalized.starts_with('/')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."));
    (!invalid).then(|| {
        if directory {
            format!("{normalized}/")
        } else {
            normalized.into()
        }
    })
}

fn read_project_context(
    value: Option<&Value>,
) -> Result<Option<SubsessionProjectContext>, BtccError> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let object = value.as_object().ok_or_else(invalid)?;
    Ok(Some(SubsessionProjectContext {
        project_id: optional_text(object, "project_id").ok_or_else(invalid)?,
        mandatory_hot_cache_refs: string_array(object.get("mandatory_hot_cache_refs"))?,
        optional_hot_cache_refs: string_array(object.get("optional_hot_cache_refs"))?,
    }))
}

fn string_array(value: Option<&Value>) -> Result<Vec<String>, BtccError> {
    let Some(Value::Array(values)) = value else {
        return Ok(Vec::new());
    };
    values
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or_else(invalid)?;
            let trimmed = trim_js_whitespace(value);
            if trimmed.is_empty() {
                Err(invalid())
            } else {
                Ok(trimmed.into())
            }
        })
        .collect()
}

fn optional_text(object: &Map<String, Value>, key: &str) -> Option<String> {
    let value = trim_js_whitespace(object.get(key)?.as_str()?);
    (!value.is_empty()).then(|| value.into())
}
fn stable_unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
fn file_scope_required(values: &[String]) -> bool {
    values.iter().any(|value| {
        matches!(
            value.as_str(),
            "edit_file:workspace" | "write_file:workspace"
        )
    })
}
fn invalid() -> BtccError {
    error("subsession_context_invalid")
}
fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
