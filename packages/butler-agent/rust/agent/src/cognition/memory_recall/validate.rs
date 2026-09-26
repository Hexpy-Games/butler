//! Source-order validation and canonical timestamp normalization.

use crate::public_text::fixed_regex;
use std::sync::OnceLock;

use regex::Regex;

use crate::cognition::{
    CognitionError, CognitionResult,
    recall::{RecallProjectFilter, RecallRequest, RecallScope},
};
use crate::segmentation::grapheme_segments;

pub(super) fn normalize(
    mut input: RecallRequest,
    parse_date: impl Fn(&str) -> Option<i64>,
) -> CognitionResult<RecallRequest> {
    if [
        &input.runtime.session_id,
        &input.runtime.turn_id,
        &input.runtime.current_user_message,
        &input.runtime.native_operation_id,
    ]
    .iter()
    .any(|value| crate::public_text::trim_js_whitespace(value).is_empty())
    {
        return Err(failure("invalid_runtime_binding"));
    }
    if crate::public_text::trim_js_whitespace(&input.cue).is_empty()
        || grapheme_segments(&input.cue).count() > 2048
    {
        return Err(failure("invalid_arguments"));
    }
    if !(1..=20).contains(&input.limit) {
        return Err(failure("invalid_arguments"));
    }
    if input.seed_phrases.len() > 16
        || input
            .seed_phrases
            .iter()
            .any(|phrase| phrase.is_empty() || grapheme_segments(phrase).count() > 512)
    {
        return Err(failure("invalid_arguments"));
    }
    if input.vector_queries.len() > 4
        || input
            .vector_queries
            .iter()
            .any(|phrase| phrase.is_empty() || grapheme_segments(phrase).count() > 2048)
    {
        return Err(failure("invalid_arguments"));
    }
    if input.session_ids.len() > 32 || input.project_ids.len() > 16 {
        return Err(failure("invalid_arguments"));
    }
    if (input.project_filter == RecallProjectFilter::Selected) == input.project_ids.is_empty() {
        return Err(failure("invalid_arguments"));
    }
    if input.scope == RecallScope::CurrentProject && input.runtime.project_id.is_none() {
        return Err(failure("invalid_scope"));
    }
    if input.scope == RecallScope::CurrentSession && input.runtime.session_id.is_empty() {
        return Err(failure("invalid_scope"));
    }
    let as_of = timestamp(&input.as_of, &parse_date)?;
    let normalized_time = if let Some(mut time) = input.time {
        let from = timestamp(&time.from, &parse_date)?;
        let to = timestamp(&time.to, &parse_date)?;
        if parse_date(&time.from) >= parse_date(&time.to) {
            return Err(failure("invalid_arguments"));
        }
        time.from = from;
        time.to = to;
        Some(time)
    } else {
        None
    };
    input.as_of = as_of;
    input.time = normalized_time;
    Ok(input)
}

fn timestamp(text: &str, parse_date: &impl Fn(&str) -> Option<i64>) -> CognitionResult<String> {
    static OFFSET: OnceLock<Regex> = OnceLock::new();
    let offset = OFFSET.get_or_init(|| {
        fixed_regex(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
    });
    if !offset.is_match(text) {
        return Err(failure("invalid_arguments"));
    }
    let millis = parse_date(text).ok_or_else(|| failure("invalid_arguments"))?;
    crate::js_date::format_iso_millis(millis).ok_or_else(|| failure("invalid_arguments"))
}

fn failure(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
