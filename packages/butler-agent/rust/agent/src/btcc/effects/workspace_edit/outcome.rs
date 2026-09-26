use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::normalized;
use crate::btcc::effects::contracts::{
    AdapterOutcome, EffectAdapterError, EffectError, EffectResult, RegisteredEditPort,
};
use crate::workspace::{
    EffectFileObservation, EffectFileScope, guard_effect_file, observe_effect_file,
};

fn error(code: &str, message: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, message)
}
fn invalid() -> EffectAdapterError {
    error(
        "workspace_target_input_mismatch",
        "The reviewed edit target does not match its normalized input.",
    )
}

async fn states(
    scope: &EffectFileScope,
    input: &Value,
) -> Result<Vec<(usize, String)>, EffectAdapterError> {
    let mut found = Vec::new();
    for entry in normalized::entries(input) {
        let path = entry["path"].as_str().unwrap_or("");
        let guarded = guard_effect_file(scope, path)
            .await
            .map_err(|failure| error(&failure.code, failure.message))?;
        match observe_effect_file(&guarded).await {
            EffectFileObservation::File { bytes, sha256 } => found.push((bytes, sha256)),
            EffectFileObservation::Missing => {
                return Err(error("not_found", "The reviewed edit target is missing."));
            }
            EffectFileObservation::Unavailable(failure) => {
                return Err(error(&failure.code, failure.message));
            }
        }
    }
    Ok(found)
}

fn matches(input: &Value, states: &[(usize, String)], field: &str) -> bool {
    normalized::entries(input)
        .iter()
        .zip(states)
        .all(|(entry, (_, sha))| entry.get(field).and_then(Value::as_str) == Some(sha))
}

fn registered_input(input: &Value) -> Value {
    let convert = |entry: &Value| {
        json!({
            "path":entry["path"],"start_line":entry["start_line"],
            "old_text":entry["old_text"],"new_text":entry["new_text"],
            "expected_sha256":entry["before_sha256"],
        })
    };
    if let Some(edits) = input.get("edits").and_then(Value::as_array) {
        json!({"edits":edits.iter().map(convert).collect::<Vec<_>>()})
    } else {
        convert(input)
    }
}

fn applied(
    input: &Value,
    states: &[(usize, String)],
    registered: Option<&Value>,
) -> EffectResult<AdapterOutcome> {
    let entries = normalized::entries(input);
    let result = if input.get("edits").is_some() {
        let rows: Vec<Value> = entries
            .iter()
            .zip(states)
            .enumerate()
            .map(|(index, (entry, (bytes, _)))| {
                json!({"index":index,"start_line":entry["start_line"],"bytes":bytes,
                "before_sha256":entry["before_sha256"],"after_sha256":entry["after_sha256"]})
            })
            .collect();
        let mut last = std::collections::HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            if let Some(path) = entry["path"].as_str() {
                last.insert(path, index);
            }
        }
        let files = last
            .values()
            .filter(|index| entries[**index]["before_sha256"] != entries[**index]["after_sha256"])
            .count();
        let bytes: usize = last.values().map(|index| states[*index].0).sum();
        let mut result = json!({"ok":true,"effect":"workspace_file_edit_batch","files":files,
            "bytes":bytes,"entries":rows,"target_observed":true});
        if let Some(details) = registered
            .and_then(|value| value.get("changed_files"))
            .and_then(Value::as_array)
            .filter(|array| !array.is_empty())
        {
            result["changed_files"] = Value::Array(
                details
                    .iter()
                    .filter(|value| value.is_object())
                    .cloned()
                    .collect(),
            );
        }
        result
    } else {
        let entry = entries[0];
        let mut result = json!({"ok":true,"effect":"workspace_file_edit","path":entry["path"],
            "start_line":entry["start_line"],"bytes":states[0].0,
            "before_sha256":entry["before_sha256"],"after_sha256":entry["after_sha256"],
            "target_observed":true});
        if let Some(detail) = registered
            .and_then(|value| value.get("changed_file"))
            .filter(|value| value.is_object())
        {
            result["changed_file"] = detail.clone();
        }
        result
    };
    crate::json::JsonDocument::from_value(&result)
        .map(AdapterOutcome::Applied)
        .map_err(|failure| {
            crate::btcc::effects::contracts::EffectFailure::adapter(failure.to_string())
        })
}

fn rejection(result: &Value) -> Option<EffectAdapterError> {
    (result.get("ok") == Some(&Value::Bool(false))).then(|| {
        let code = result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("registered_edit_file_rejected");
        error(
            code,
            result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The registered edit_file tool rejected the reviewed edit."),
        )
    })
}

pub(super) async fn dispatch(
    scope: &EffectFileScope,
    registered: &dyn RegisteredEditPort,
    target: &str,
    input: &Value,
    signal: &CancellationToken,
) -> EffectResult<AdapterOutcome> {
    if normalized::target_for(input).as_deref() != Ok(target) {
        return Ok(AdapterOutcome::NotApplied(invalid()));
    }
    if signal.is_cancelled() {
        return Ok(AdapterOutcome::NotApplied(error(
            "edit_file_cancelled",
            "edit_file was cancelled before registered tool dispatch.",
        )));
    }
    let before = match states(scope, input).await {
        Ok(value) => value,
        Err(failure) => return Ok(AdapterOutcome::NotApplied(failure)),
    };
    if !matches(input, &before, "before_sha256") {
        return Ok(AdapterOutcome::NotApplied(error(
            "expected_sha256_mismatch",
            "The workspace file changed before the reviewed edit was applied.",
        )));
    }
    let registered_result = registered.edit(registered_input(input)).await?;
    let after = states(scope, input).await;
    if input.get("edits").is_some()
        && registered_result.get("error").and_then(Value::as_str) == Some("partial_apply")
    {
        return Ok(AdapterOutcome::Uncertain(rejection(&registered_result)));
    }
    let after = match after {
        Ok(value) => value,
        Err(failure) => return Ok(AdapterOutcome::Uncertain(Some(failure))),
    };
    if matches(input, &after, "after_sha256") {
        return applied(input, &after, Some(&registered_result));
    }
    if let Some(failure) = rejection(&registered_result)
        && (input.get("edits").is_none() || matches(input, &after, "before_sha256"))
    {
        return Ok(AdapterOutcome::NotApplied(failure));
    }
    Ok(AdapterOutcome::Uncertain(Some(error(
        "workspace_file_state_mismatch",
        "One or more workspace files match neither the durable before nor after state.",
    ))))
}

pub(super) async fn reconcile(
    scope: &EffectFileScope,
    target: &str,
    input: &Value,
    attempts: i64,
    prior: Option<&EffectError>,
) -> EffectResult<AdapterOutcome> {
    if normalized::target_for(input).as_deref() != Ok(target) {
        return Ok(AdapterOutcome::Uncertain(Some(invalid())));
    }
    let current = match states(scope, input).await {
        Ok(value) => value,
        Err(failure) => return Ok(AdapterOutcome::Uncertain(Some(failure))),
    };
    let ambiguous = prior.is_some_and(|error| {
        matches!(
            error.source_code.as_deref(),
            Some("partial_apply" | "workspace_file_state_mismatch")
        )
    });
    if matches(input, &current, "before_sha256") && !ambiguous {
        return Ok(AdapterOutcome::NotApplied(error(
            "not_applied",
            "not applied",
        )));
    }
    if matches(input, &current, "after_sha256") && attempts > 0 {
        return applied(input, &current, None);
    }
    if matches(input, &current, "after_sha256") && attempts == 0 {
        return Ok(AdapterOutcome::NotApplied(error(
            "not_applied",
            "not applied",
        )));
    }
    Ok(AdapterOutcome::Uncertain(Some(error(
        "workspace_file_state_mismatch",
        "One or more workspace files match neither the durable before nor after state.",
    ))))
}
