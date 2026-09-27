//! Public v2 recall arguments and canonical caller binding. Graph retrieval stays
//! in the recall operation; this short read never retains a Conversation handle.
//!
//! Checks run in the order the public tool reports them: caller binding,
//! cue, runtime binding, active generation, then each argument.

use crate::cognition::CognitionCode;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cognition::recall::{RecallProjectFilter, RecallRuntime, RecallScope, RecallTime};
use crate::cognition::{CognitionError, CognitionResult, RecallRequest};
use crate::lenient::Arg;
use butler_core::public_text::trim_js_whitespace;
use butler_core::segmentation::grapheme_segments;
use butler_turn::conversation::{
    CanonicalMemoryReadBinding, PublicMemoryScope, PublicMemorySnapshot, conversation_store_path,
};

/// The `recall_memory` tool arguments, each kept as sent so that a wrong type
/// is reported by the check that owns it.
#[derive(Debug, Default, Deserialize)]
pub(super) struct RecallToolArgs {
    #[serde(default)]
    cue: Arg<String>,
    #[serde(default)]
    limit: Arg<f64>,
    #[serde(default)]
    scope: Arg<RecallScope>,
    #[serde(default)]
    project_filter: Arg<RecallProjectFilter>,
    #[serde(default)]
    project_ids: Arg<Vec<String>>,
    #[serde(default)]
    session_ids: Arg<Vec<String>>,
    #[serde(default)]
    include_internal: Arg<bool>,
    #[serde(default)]
    include_vector: Arg<bool>,
    #[serde(default)]
    time: Arg<RecallTime>,
    #[serde(default)]
    seed_phrases: Arg<Vec<String>>,
    #[serde(default)]
    vector_queries: Arg<Vec<String>>,
    #[serde(default)]
    as_of: Arg<String>,
    #[serde(default)]
    cursor: Arg<String>,
}

pub(super) enum PreparedRecall {
    Request(Box<RecallRequest>),
    BindingFailure(BindingFailure),
}

/// The tool result when the caller's conversation binding cannot be read.
#[derive(Serialize)]
pub(super) struct BindingFailure {
    ok: bool,
    code: &'static str,
    diagnostics: [(); 0],
}

/// The caller binding and runtime of one recall call.
pub(super) struct RecallCaller {
    pub binding: CanonicalMemoryReadBinding,
    pub current_user_message: String,
    pub operation_id: String,
}

pub(super) fn prepare(
    data_root: &Path,
    environment: &crate::cognition::CognitionPathEnvironment,
    caller: RecallCaller,
    args: &RecallToolArgs,
    now_iso: &str,
) -> CognitionResult<PreparedRecall> {
    let binding = caller.binding;
    let snapshot = match PublicMemorySnapshot::open(&conversation_store_path(data_root), &binding) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return Ok(PreparedRecall::BindingFailure(BindingFailure {
                ok: false,
                code: if error.code() == "invalid_scope" {
                    "invalid_scope"
                } else {
                    "backend_unavailable"
                },
                diagnostics: [],
            }));
        }
    };
    let cue = args.cue.valid().map_or("", |cue| trim_js_whitespace(cue));
    if cue.is_empty() {
        return Err(failure(CognitionCode::RecallMemoryRequiresCue));
    }
    if trim_js_whitespace(&caller.current_user_message).is_empty()
        || trim_js_whitespace(&caller.operation_id).is_empty()
    {
        return Err(failure(CognitionCode::InvalidRuntimeBinding));
    }
    // The public wrapper binds Conversation first; its v2 executor then resolves
    // the active generation before validating query arguments.
    crate::cognition::resolve_active_generation(data_root, environment)?;
    let limit = limit(&args.limit)?;
    let public_scope = public_scope(args, &snapshot, &binding)?;
    let time = match &args.time {
        Arg::Missing => None,
        Arg::Valid(time) => Some(time.clone()),
        Arg::Invalid => return Err(failure(CognitionCode::RecallMemoryInvalidTime)),
    };
    let runtime = RecallRuntime {
        session_id: snapshot.current_session_id.clone(),
        turn_id: binding.turn_id,
        current_user_message: caller.current_user_message,
        native_operation_id: caller.operation_id,
        project_id: binding.project_id,
    };
    Ok(PreparedRecall::Request(Box::new(RecallRequest {
        cue: cue.to_owned(),
        seed_phrases: strings(&args.seed_phrases, 16, 512)?,
        vector_queries: strings(&args.vector_queries, 4, 2048)?,
        include_vector: args.include_vector != Arg::Valid(false),
        include_internal: public_scope.include_internal,
        limit,
        scope: public_scope.scope,
        project_filter: public_scope.project_filter,
        project_ids: public_scope.inner.project_ids,
        session_ids: public_scope.inner.session_ids,
        as_of: args
            .as_of
            .valid()
            .map_or(now_iso, String::as_str)
            .to_owned(),
        as_of_explicit: args.as_of.valid().is_some(),
        time,
        cursor: args.cursor.valid().cloned(),
        admitted_channels: None,
        runtime,
    })))
}

/// 1..=20 results, 6 when not given.
fn limit(limit: &Arg<f64>) -> CognitionResult<usize> {
    match limit {
        Arg::Missing => Ok(6),
        Arg::Valid(value) if value.fract() == 0.0 && (1.0..=20.0).contains(value) => {
            Ok(butler_core::json::saturating_usize(*value))
        }
        Arg::Valid(_) | Arg::Invalid => Err(failure(CognitionCode::InvalidArguments)),
    }
}

/// The requested scope, checked against what the caller may read.
struct CheckedScope {
    scope: RecallScope,
    project_filter: RecallProjectFilter,
    include_internal: bool,
    inner: PublicMemoryScope,
}

/// Scope defaults to the current project when the caller has one, else all
/// user sessions; project filter defaults to any.
fn public_scope(
    args: &RecallToolArgs,
    snapshot: &PublicMemorySnapshot,
    binding: &CanonicalMemoryReadBinding,
) -> CognitionResult<CheckedScope> {
    let scope = match &args.scope {
        Arg::Missing
            if binding
                .project_id
                .as_ref()
                .is_some_and(|value| !value.is_empty()) =>
        {
            RecallScope::CurrentProject
        }
        Arg::Missing => RecallScope::AllUserSessions,
        Arg::Valid(scope) => *scope,
        Arg::Invalid => return Err(failure(CognitionCode::InvalidArguments)),
    };
    let project_filter = match &args.project_filter {
        Arg::Missing => RecallProjectFilter::Any,
        Arg::Valid(filter) => *filter,
        Arg::Invalid => return Err(failure(CognitionCode::InvalidArguments)),
    };
    let project_ids = strings(&args.project_ids, 16, 512)?;
    let session_ids = strings(&args.session_ids, 32, 512)?;
    let include_internal = args.include_internal == Arg::Valid(true);
    let inner = PublicMemoryScope {
        current_session_id: snapshot.current_session_id.clone(),
        current_project_id: binding.project_id.clone(),
        kind: scope.as_str().to_owned(),
        session_ids,
        project_filter: project_filter.as_str().to_owned(),
        project_ids,
        include_internal,
    };
    if !snapshot
        .validate_scope(&inner)
        .map_err(|e| CognitionError::new(CognitionCode::BackendUnavailable, e.code()))?
    {
        return Err(failure(CognitionCode::InvalidScope));
    }
    Ok(CheckedScope {
        scope,
        project_filter,
        include_internal,
        inner,
    })
}

/// At most `max_items` non-blank strings of at most `max_graphemes` each,
/// trimmed; none when not given.
fn strings(
    value: &Arg<Vec<String>>,
    max_items: usize,
    max_graphemes: usize,
) -> CognitionResult<Vec<String>> {
    let values = match value {
        Arg::Missing => return Ok(Vec::new()),
        Arg::Valid(values) if values.len() <= max_items => values,
        Arg::Valid(_) | Arg::Invalid => return Err(failure(CognitionCode::InvalidArguments)),
    };
    values
        .iter()
        .map(|value| {
            if trim_js_whitespace(value).is_empty()
                || grapheme_segments(value).count() > max_graphemes
            {
                return Err(failure(CognitionCode::InvalidArguments));
            }
            Ok(trim_js_whitespace(value).to_owned())
        })
        .collect()
}

fn failure(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
