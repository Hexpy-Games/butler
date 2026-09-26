//! Public v2 recall arguments and canonical caller binding. Graph retrieval stays
//! in the recall operation; this short read never retains a Conversation handle.

use std::path::Path;

use serde_json::{Value, json};

use crate::cognition::{CognitionError, CognitionResult, RecallRequest};
use crate::conversation::{
    CanonicalMemoryReadBinding, PublicMemoryScope, PublicMemorySnapshot, conversation_store_path,
};
use crate::public_text::trim_js_whitespace;
use crate::segmentation::grapheme_segments;

use crate::cognition::recall::{RecallRuntime, RecallScope};

pub(super) enum PreparedRecall {
    Request(Box<RecallRequest>),
    BindingFailure(Value),
}

pub(super) fn prepare(
    data_root: &Path,
    environment: &crate::cognition::CognitionPathEnvironment,
    binding: CanonicalMemoryReadBinding,
    current_user_message: String,
    operation_id: String,
    args: &Value,
    now_iso: &str,
) -> CognitionResult<PreparedRecall> {
    let snapshot = match PublicMemorySnapshot::open(&conversation_store_path(data_root), &binding) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return Ok(PreparedRecall::BindingFailure(json!({
                "ok": false,
                "code": if error.code() == "invalid_scope" { "invalid_scope" } else { "backend_unavailable" },
                "diagnostics": [],
            })));
        }
    };
    let cue = args
        .get("cue")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .unwrap_or("");
    if cue.is_empty() {
        return Err(failure("recall_memory requires cue"));
    }
    if trim_js_whitespace(&current_user_message).is_empty()
        || trim_js_whitespace(&operation_id).is_empty()
    {
        return Err(failure("invalid_runtime_binding"));
    }
    // The public wrapper binds Conversation first; its v2 executor then resolves
    // the active generation before validating query arguments.
    crate::cognition::resolve_active_generation(data_root, environment)?;
    let limit = match args.get("limit") {
        None => 6,
        Some(value) => crate::json::saturating_usize(
            value
                .as_f64()
                .filter(|v| v.fract() == 0.0 && (1.0..=20.0).contains(v))
                .ok_or_else(|| failure("invalid_arguments"))?,
        ),
    };
    let scope = match args.get("scope") {
        None if binding
            .project_id
            .as_ref()
            .is_some_and(|value| !value.is_empty()) =>
        {
            "current_project"
        }
        None => "all_user_sessions",
        Some(Value::String(value))
            if ["current_session", "current_project", "all_user_sessions"]
                .contains(&value.as_str()) =>
        {
            value
        }
        _ => return Err(failure("invalid_arguments")),
    };
    let project_filter = match args.get("project_filter") {
        None => "any",
        Some(Value::String(value))
            if ["any", "unassigned", "selected"].contains(&value.as_str()) =>
        {
            value
        }
        _ => return Err(failure("invalid_arguments")),
    };
    let project_ids = strings(args.get("project_ids"), 16, 512)?;
    let session_ids = strings(args.get("session_ids"), 32, 512)?;
    let public_scope = PublicMemoryScope {
        current_session_id: snapshot.current_session_id.clone(),
        current_project_id: binding.project_id.clone(),
        kind: scope.to_owned(),
        session_ids: session_ids.clone(),
        project_filter: project_filter.to_owned(),
        project_ids: project_ids.clone(),
        include_internal: args.get("include_internal") == Some(&Value::Bool(true)),
    };
    if !snapshot
        .validate_scope(&public_scope)
        .map_err(|e| CognitionError::new("backend_unavailable", e.code()))?
    {
        return Err(failure("invalid_scope"));
    }
    let time = args
        .get("time")
        .map(|value| {
            let valid = value.get("from").is_some_and(Value::is_string)
                && value.get("to").is_some_and(Value::is_string)
                && matches!(
                    value.get("basis").and_then(Value::as_str),
                    Some("conversation" | "event")
                );
            if !valid {
                return Err(failure("recall_memory invalid time"));
            }
            serde_json::from_value(value.clone()).map_err(|_| failure("invalid_arguments"))
        })
        .transpose()?;
    let runtime = RecallRuntime {
        session_id: snapshot.current_session_id.clone(),
        turn_id: binding.turn_id,
        current_user_message,
        native_operation_id: operation_id,
        project_id: binding.project_id,
    };
    Ok(PreparedRecall::Request(Box::new(RecallRequest {
        cue: cue.to_owned(),
        seed_phrases: strings(args.get("seed_phrases"), 16, 512)?,
        vector_queries: strings(args.get("vector_queries"), 4, 2048)?,
        include_vector: args.get("include_vector") != Some(&Value::Bool(false)),
        include_internal: public_scope.include_internal,
        limit,
        scope: match scope {
            "current_session" => RecallScope::CurrentSession,
            "current_project" => RecallScope::CurrentProject,
            _ => RecallScope::AllUserSessions,
        },
        project_filter: serde_json::from_value(json!(project_filter))
            .map_err(|_| failure("invalid_arguments"))?,
        project_ids,
        session_ids,
        as_of: args
            .get("as_of")
            .and_then(Value::as_str)
            .unwrap_or(now_iso)
            .to_owned(),
        as_of_explicit: args.get("as_of").is_some_and(Value::is_string),
        time,
        cursor: args
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
        admitted_channels: None,
        runtime,
    })))
}

fn strings(
    value: Option<&Value>,
    max_items: usize,
    max_graphemes: usize,
) -> CognitionResult<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .filter(|items| items.len() <= max_items)
        .ok_or_else(|| failure("invalid_arguments"))?;
    values
        .iter()
        .map(|value| {
            let value = value.as_str().ok_or_else(|| failure("invalid_arguments"))?;
            if trim_js_whitespace(value).is_empty()
                || grapheme_segments(value).count() > max_graphemes
            {
                return Err(failure("invalid_arguments"));
            }
            Ok(trim_js_whitespace(value).to_owned())
        })
        .collect()
}

fn failure(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
