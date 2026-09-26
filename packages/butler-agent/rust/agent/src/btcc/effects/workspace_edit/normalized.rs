use serde_json::{Value, json};

use crate::workspace::EffectFileScope;

use super::super::contracts::{EffectFailure, EffectResult, RecoveryEntry, RecoveryHint};

fn invalid(message: impl Into<String>) -> EffectFailure {
    EffectFailure::policy("effect_request_invalid", message)
}

pub(super) fn input(value: &Value, scope: &EffectFileScope) -> EffectResult<Value> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("edit_file effect input must be an object"))?;
    if let Some(edits) = object.get("edits") {
        if object.len() != 1 {
            return Err(invalid(
                "edit_file effect rejects mixed single and batch input",
            ));
        }
        let edits = edits
            .as_array()
            .filter(|items| (2..=20).contains(&items.len()))
            .ok_or_else(|| invalid("edit_file batch requires 2-20 entries"))?;
        return Ok(
            json!({"edits":edits.iter().map(|entry| normalize_entry(entry, scope))
            .collect::<EffectResult<Vec<_>>>()?}),
        );
    }
    normalize_entry(value, scope)
}

fn normalize_entry(value: &Value, scope: &EffectFileScope) -> EffectResult<Value> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("edit_file effect entry must be an object"))?;
    if let Some(unknown) = object.keys().find(|key| {
        !matches!(
            key.as_str(),
            "path" | "start_line" | "old_text" | "new_text" | "before_sha256" | "after_sha256"
        )
    }) {
        return Err(invalid(format!(
            "edit_file effect rejects unknown input: {unknown}"
        )));
    }
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("edit_file requires path"))?;
    let path = crate::btcc::effects::workspace_file::normalized_workspace_effect_path(scope, path)?;
    let line = crate::json::saturating_u64(
        object
            .get("start_line")
            .and_then(Value::as_f64)
            .filter(|number| {
                number.is_finite()
                    && number.fract() == 0.0
                    && (1.0..=9_007_199_254_740_991.0).contains(number)
            })
            .ok_or_else(|| invalid("edit_file effect start_line must be a positive integer"))?,
    );
    let old_text = object
        .get("old_text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid("edit_file effect old_text must be non-empty"))?;
    let new_text = object
        .get("new_text")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("edit_file effect new_text must be a string"))?;
    let before = sha(object.get("before_sha256"), "before_sha256")?;
    let after = sha(object.get("after_sha256"), "after_sha256")?;
    Ok(
        json!({"path":path,"start_line":line,"old_text":old_text,"new_text":new_text,
        "before_sha256":before,"after_sha256":after}),
    )
}

fn sha(value: Option<&Value>, field: &str) -> EffectResult<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid(format!("edit_file effect requires {field}")))
}

pub(super) fn entries(input: &Value) -> Vec<&Value> {
    input
        .get("edits")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_else(|| vec![input])
}

pub(super) fn target(value: &str) -> EffectResult<String> {
    if let Some(digest) = value.strip_prefix("workspace:batch:") {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid(
                "edit_file batch target must use workspace:batch:<sha256>",
            ));
        }
        return Ok(format!("workspace:batch:{}", digest.to_ascii_lowercase()));
    }
    crate::btcc::effects::workspace_file::normalized_workspace_effect_target(value)
}

pub(super) fn target_for(input: &Value) -> EffectResult<String> {
    if input.get("edits").is_some() {
        batch_target(
            &entries(input)
                .iter()
                .filter_map(|entry| entry.get("path").and_then(Value::as_str).map(str::to_owned))
                .collect::<Vec<_>>(),
        )
    } else {
        Ok(format!(
            "workspace:{}",
            input["path"].as_str().unwrap_or("")
        ))
    }
}

pub(super) fn batch_target(paths: &[String]) -> EffectResult<String> {
    let body = json!({"version":1,"paths":paths});
    let encoded =
        crate::json::stringify_sorted(&body, &|a, b| a.encode_utf16().cmp(b.encode_utf16()))
            .map_err(|error| invalid(error.to_string()))?;
    Ok(format!(
        "workspace:batch:{}",
        crate::btcc::digest_identity(&encoded)
    ))
}

pub(super) fn recovery_hint(input: &Value) -> EffectResult<RecoveryHint> {
    let entries = entries(input);
    if input.get("edits").is_some() {
        Ok(RecoveryHint::Batch {
            capability: "edit_file".into(),
            entries: entries
                .iter()
                .map(|entry| {
                    Ok(RecoveryEntry {
                        path: entry["path"].as_str().unwrap_or("").into(),
                        start_line: entry["start_line"].as_i64().unwrap_or(0),
                        before_sha256: entry["before_sha256"].as_str().unwrap_or("").into(),
                        after_sha256: entry["after_sha256"].as_str().unwrap_or("").into(),
                    })
                })
                .collect::<EffectResult<Vec<_>>>()?,
        })
    } else {
        Ok(RecoveryHint::Single {
            capability: "edit_file".into(),
            start_line: input["start_line"].as_i64().unwrap_or(0),
            before_sha256: input["before_sha256"].as_str().unwrap_or("").into(),
            after_sha256: input["after_sha256"].as_str().unwrap_or("").into(),
        })
    }
}
