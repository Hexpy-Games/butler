use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{
    cognition::{CognitionResult, FeedbackTarget},
    js_date,
};

use super::{entries::EntryPath, error};

pub(super) struct Snapshot {
    pub entries: Vec<EntryPath>,
    pub quality_by_source: HashMap<String, f64>,
}

pub(super) fn targeted_feedback(
    entry: &Value,
    active_feedback: &[FeedbackTarget],
) -> CognitionResult<Vec<FeedbackTarget>> {
    let id = string(entry, "knowhow_id")?;
    let strategy = entry
        .get("strategy")
        .and_then(Value::as_object)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let preferred_sources = strategy
        .get("preferred_sources")
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let targets = preferred_sources
        .iter()
        .map(|source| {
            source
                .as_str()
                .map(|source| format!("source:{source}"))
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    Ok(active_feedback
        .iter()
        .filter(|feedback| {
            feedback.target_ref == format!("knowhow:{id}")
                || targets.iter().any(|target| target == &feedback.target_ref)
        })
        .cloned()
        .collect())
}

pub(super) fn revise_from_feedback(
    entry: &Value,
    targeted: &[FeedbackTarget],
) -> CognitionResult<Value> {
    let mut next = entry.clone();
    let previous_status = string(entry, "status")?;
    let disable = targeted
        .iter()
        .any(|feedback| feedback.category == "source_policy");
    let now = now_iso();
    let object = next
        .as_object_mut()
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    object.insert(
        "status".into(),
        json!(if disable { "disabled" } else { "needs_review" }),
    );
    object.insert("updated_at".into(), json!(now));

    let quality = object
        .get_mut("quality")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let score = quality
        .get("score")
        .and_then(Value::as_f64)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    quality.insert("score".into(), json!(round3((score - 0.25).max(0.0))));
    let negative_feedback_count = quality
        .get("negative_feedback_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    quality.insert(
        "negative_feedback_count".into(),
        json!(negative_feedback_count.saturating_add(targeted.len() as u64)),
    );

    let refs = object
        .get_mut("refs")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let feedback_ids = refs
        .get_mut("feedback_ids")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    for feedback in targeted {
        let id = Value::String(feedback.feedback_id.clone());
        if !feedback_ids.contains(&id) {
            feedback_ids.push(id);
        }
    }

    let history = object
        .get_mut("revision_history")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    history.push(json!({
        "at": now_iso(),
        "kind": "feedback_revision",
        "feedback_ids": targeted.iter().map(|feedback| &feedback.feedback_id).collect::<Vec<_>>(),
        "previous_status": previous_status,
    }));
    Ok(next)
}

pub(super) fn demote_for_source_quality(
    entry: &mut Value,
    quality_by_source: &HashMap<String, f64>,
) -> CognitionResult<bool> {
    let preferred_sources = entry
        .get("strategy")
        .and_then(Value::as_object)
        .and_then(|strategy| strategy.get("preferred_sources"))
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let scores = preferred_sources
        .iter()
        .map(|source| {
            let source = source
                .as_str()
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
            Ok(quality_by_source.get(source).copied())
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    let current_status = string(entry, "status")?;
    let next_status = if scores.iter().flatten().any(|score| *score < 0.35) {
        Some("disabled")
    } else if scores.iter().flatten().any(|score| *score < 0.55) && current_status == "active" {
        Some("needs_review")
    } else {
        None
    };
    let Some(next_status) = next_status else {
        return Ok(false);
    };
    let object = entry
        .as_object_mut()
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    object.insert("status".into(), json!(next_status));
    object.insert("updated_at".into(), json!(now_iso()));
    Ok(true)
}

fn string<'a>(value: &'a Value, field: &str) -> CognitionResult<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    js_date::format_iso_millis(millis).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}
