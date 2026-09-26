use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{conversation::PublicMemoryScope, json};

use super::{ContextError, ContextResult};

pub(super) struct ReadArgs {
    pub(super) scope: PublicMemoryScope,
    pub(super) scope_hash: String,
}

pub(super) fn parse(
    input: &Value,
    current_session_id: &str,
    project_id: Option<&str>,
) -> Result<ReadArgs, &'static str> {
    let project_id = project_id.map(str::trim).filter(|value| !value.is_empty());
    let kind = input
        .get("scope")
        .and_then(Value::as_str)
        .filter(|value| {
            [
                "current_session",
                "current_project",
                "all_user_sessions",
                "all_sessions",
            ]
            .contains(value)
        })
        .unwrap_or(if project_id.is_some() {
            "current_project"
        } else {
            "all_user_sessions"
        });
    if !["current_session", "current_project", "all_user_sessions"].contains(&kind)
        || kind == "current_project" && project_id.is_none()
    {
        return Err("invalid_scope");
    }
    let session_ids = strings(
        input.get("session_ids").filter(|value| value.is_array()),
        32,
    )?;
    let project_ids = strings(
        input.get("project_ids").filter(|value| value.is_array()),
        16,
    )?;
    let project_filter = match input.get("project_filter") {
        None | Some(Value::Null) => "any",
        Some(value) => value.as_str().ok_or("invalid_arguments")?,
    };
    if !["any", "unassigned", "selected"].contains(&project_filter)
        || (project_filter == "selected") == project_ids.is_empty()
    {
        return Err("invalid_arguments");
    }
    let include_internal = input.get("include_internal") == Some(&Value::Bool(true));
    let scope = PublicMemoryScope {
        current_session_id: current_session_id.into(),
        current_project_id: project_id.map(str::to_owned),
        kind: kind.into(),
        session_ids,
        project_filter: project_filter.into(),
        project_ids,
        include_internal,
    };
    let hash_value = json!({"scope":kind,"project_id":if kind == "current_project" { project_id } else { None },
        "session_ids":scope.session_ids,"project_filter":scope.project_filter,"project_ids":scope.project_ids,
        "include_internal":include_internal});
    let hash_text = json::stringify(&hash_value).map_err(|_| "invalid_arguments")?;
    let scope_hash = format!("{:x}", Sha256::digest(hash_text.as_bytes()));
    Ok(ReadArgs { scope, scope_hash })
}

fn strings(value: Option<&Value>, limit: usize) -> Result<Vec<String>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .filter(|values| values.len() <= limit)
        .ok_or("invalid_arguments")?;
    values
        .iter()
        .map(|value| {
            let text = value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .ok_or("invalid_arguments")?;
            Ok(text.to_owned())
        })
        .collect()
}

pub(super) fn integer(
    value: Option<&Value>,
    fallback: usize,
    minimum: usize,
    maximum: usize,
) -> ContextResult<usize> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let number = value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && *number >= minimum as f64
                && *number <= maximum as f64
        })
        .ok_or_else(|| ContextError::new("invalid_integer", "Integer is outside source range"))?;
    Ok(number as usize)
}

pub(super) fn failure(code: &str, diagnostics: &[&str]) -> Value {
    json!({"ok":false,"code":code,"diagnostics":diagnostics})
}
