//! Replay side of the provider: echo ids, fault bookkeeping, re-minted ids
//! and the paced (optionally faulted) response stream.

use std::time::Duration;

use axum::body::Body;
use axum::http::{Response, StatusCode};
use bytes::Bytes;

use super::super::cassette::{self, ResponseRecord};
use super::super::faults::{Transform, mutate_chunk};
use super::{State, lock};

/// Product-generated ids the model must echo back verbatim differ per run:
/// the Work id in work tool calls (`ECHO_<n>`), and the plan and message ids
/// a project briefing cites as sources (`PLAN_ECHO_<n>`, `MSG_ECHO_<n>`).
/// Each distinct id gets the next name of its kind in order of first
/// appearance in requests: the recorder hides it in replies, and replay
/// substitutes the current run's id for the same name.
pub(super) fn learn_echo_ids(state: &State, request: &str) {
    const UUID: &str = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    static PATTERNS: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> =
        std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (r"guided-work-[0-9a-f]{64}".to_owned(), "ECHO_"),
            (r"guided-plan-[0-9a-f]{64}".to_owned(), "PLAN_ECHO_"),
            // A streamed answer keeps its provisional id, `message-stream-<turn>`.
            (format!(r"\bmessage-(?:stream-turn-)?{UUID}"), "MSG_ECHO_"),
        ]
        .into_iter()
        .filter_map(|(pattern, prefix)| {
            regex::Regex::new(&pattern)
                .ok()
                .map(|regex| (regex, prefix))
        })
        .collect()
    });
    let mut placeholders = lock(&state.placeholders);
    for (pattern, prefix) in patterns {
        for found in pattern.find_iter(request) {
            let value = found.as_str();
            if placeholders.0.iter().any(|(_, known)| known == value) {
                continue;
            }
            let next = placeholders
                .0
                .iter()
                .filter(|(name, _)| {
                    name.strip_prefix(prefix)
                        .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit()))
                })
                .count()
                + 1;
            placeholders.add(&format!("{prefix}{next}"), value);
        }
    }
}

/// Takes the first matching fault. Tool-scoped argument mutations
/// (`ArgsMutation::OnlyTool`) are consumed lazily, only by a response that
/// actually contains a call of that tool (see [`consume_fault`]).
pub(super) fn take_fault(
    state: &State,
    index: Option<usize>,
    key: &cassette::MatchKey,
) -> Option<(usize, Transform)> {
    let mut faults = lock(&state.faults);
    let position = faults.iter().position(|fault| fault.matches(index, key))?;
    let fault = &mut faults[position];
    let lazy = matches!(
        fault.transform,
        Transform::MutateToolArgs(super::super::faults::ArgsMutation::OnlyTool { .. })
    );
    if !lazy && let Some(remaining) = fault.remaining.as_mut() {
        *remaining -= 1;
    }
    Some((position, fault.transform.clone()))
}

pub(super) fn consume_fault(state: &State, position: usize) {
    if let Some(remaining) = lock(&state.faults)
        .get_mut(position)
        .and_then(|fault| fault.remaining.as_mut())
    {
        *remaining = remaining.saturating_sub(1);
    }
}

/// A recording served again for an identical request (a retry or a resumed
/// turn) gets fresh provider object ids, as a live provider would issue:
/// `resp_`/`msg_`/`fc_`/`rs_`/`call_` ids get a `r<n>` suffix.
pub(super) fn remint_ids(response: &mut ResponseRecord, generation: usize) {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let Some(pattern) = PATTERN
        .get_or_init(|| regex::Regex::new(r#"("(?:id|item_id|call_id|response_id)"\s*:\s*")((?:resp|msg|fc|rs|call)_[A-Za-z0-9_]+)(")"#).ok())
        .as_ref()
    else {
        return;
    };
    for chunk in &mut response.chunks {
        chunk.text = pattern
            .replace_all(
                &chunk.text,
                format!("${{1}}${{2}}r{generation}${{3}}").as_str(),
            )
            .into_owned();
    }
}

pub(super) fn replay(
    state: &State,
    recorded: &ResponseRecord,
    fault: Option<(usize, Transform)>,
) -> Response<Body> {
    let position = fault.as_ref().map(|(position, _)| *position);
    let fault = fault.map(|(_, transform)| transform);
    let placeholders = lock(&state.placeholders).clone();
    let pacing = *lock(&state.pacing);
    let (response, limit, ending) = match fault {
        Some(Transform::ErrorFromLibrary(name)) => {
            let library = lock(&state.library);
            match library.iter().find(|(n, _)| *n == name) {
                Some((_, response)) => (response.clone(), usize::MAX, Ending::Clean),
                None => return plain(501, "HARNESS_ERROR: error library entry not loaded"),
            }
        }
        Some(Transform::TruncateAfter(k)) => (recorded.clone(), k, Ending::Clean),
        Some(Transform::ResetAfter(k)) => (recorded.clone(), k, Ending::Reset),
        Some(Transform::StallAfter(k)) => (recorded.clone(), k, Ending::Stall),
        Some(Transform::MutateToolArgs(op)) => {
            let mut response = recorded.clone();
            let mut changed = false;
            for chunk in &mut response.chunks {
                let mutated = mutate_chunk(&chunk.text, &op);
                changed |= mutated != chunk.text;
                chunk.text = mutated;
            }
            if changed && let Some(position) = position {
                consume_fault(state, position);
            }
            (response, usize::MAX, Ending::Clean)
        }
        None => (recorded.clone(), usize::MAX, Ending::Clean),
    };
    let now_ms = super::super::sanitize::now_ms();
    let chunks: Vec<(Duration, Bytes)> = response
        .chunks
        .iter()
        .take(limit)
        .map(|chunk| {
            let scaled = Duration::from_millis(chunk.delay_ms).mul_f64(pacing.scale.max(0.0));
            let delay = scaled
                .min(Duration::from_millis(pacing.cap_ms))
                .max(Duration::from_millis(pacing.min_ms));
            let text = super::super::sanitize::expand_times(
                &placeholders.reveal(&chunk.text, true),
                now_ms,
            );
            (delay, Bytes::from(text))
        })
        .collect();
    let stream = paced_stream(chunks, ending);
    let mut builder = Response::builder().status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| plain(500, "HARNESS_ERROR: bad recorded response"))
}

/// The recorded chunks, each after its paced delay, then the `ending`.
fn paced_stream(
    chunks: Vec<(Duration, Bytes)>,
    ending: Ending,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(
        (chunks.into_iter(), ending, false),
        |(mut chunks, ending, done)| async move {
            if done {
                return None;
            }
            if let Some((delay, bytes)) = chunks.next() {
                tokio::time::sleep(delay).await;
                return Some((Ok::<_, std::io::Error>(bytes), (chunks, ending, false)));
            }
            match ending {
                Ending::Clean => None,
                Ending::Reset => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "injected reset",
                    )),
                    (chunks, ending, true),
                )),
                Ending::Stall => {
                    std::future::pending::<()>().await;
                    None
                }
            }
        },
    )
}

#[derive(Clone, Copy)]
enum Ending {
    Clean,
    Reset,
    Stall,
}

pub(super) fn plain(status: u16, text: &str) -> Response<Body> {
    let mut response = Response::new(Body::from(text.to_owned()));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response
}
