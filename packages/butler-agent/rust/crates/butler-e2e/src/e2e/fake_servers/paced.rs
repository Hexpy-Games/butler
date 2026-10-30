//! When a streamed chat answer's bytes arrive (synthetic timings): a slow
//! prefill that sends nothing (or only headers, or only a role chunk), a
//! stream that stops after its first chunk, and a stream that never ends.
use std::convert::Infallible;
use std::time::Duration;

use futures_util::{StreamExt, stream};

use super::{Body, Bytes, ChatBehavior, LOCAL_MODEL, Response, Seen, StatusCode, Value, json};

/// How a streamed answer is paced.
#[derive(Clone, Copy, Debug, Default)]
pub enum Pace {
    /// Chunks every `chunk_delay`, then the end.
    #[default]
    Steady,
    /// Nothing at all, not even headers, for this long; then a steady answer.
    FirstByteAfter(Duration),
    /// The first streamed answer sends one chunk, then nothing; later
    /// answers are steady.
    StallFirstAfterOneChunk,
    /// A chunk every `Duration`, forever.
    Endless(Duration),
    /// Headers at once, then no body for this long; then the answer.
    HeadersThenSilence(Duration),
    /// A role-only chunk at once (no content), then nothing for this long;
    /// then the answer.
    RoleChunkThenSilence(Duration),
}

/// The paced answer for a streamed request, or None for the usual one
/// (after any first-byte wait).
pub(super) async fn response(
    chat: &ChatBehavior,
    seen: &Seen,
    first_stream: bool,
) -> Option<Response<Body>> {
    if !super::is_stream_request(seen) {
        return None;
    }
    let request: Value = serde_json::from_str(&seen.body).unwrap_or(Value::Null);
    let model = request["model"].as_str().unwrap_or(LOCAL_MODEL).to_owned();
    match chat.pace {
        Pace::Steady => None,
        Pace::StallFirstAfterOneChunk if !first_stream => None,
        Pace::FirstByteAfter(delay) => {
            tokio::time::sleep(delay).await;
            None
        }
        Pace::StallFirstAfterOneChunk => {
            let first = stream::iter([Ok::<_, Infallible>(Bytes::from(chunk(&model, "Partial ")))]);
            Some(event_stream(Body::from_stream(
                first.chain(stream::pending()),
            )))
        }
        Pace::Endless(every) => {
            let words = stream::unfold((), move |()| {
                let frame = chunk(&model, "more ");
                async move {
                    tokio::time::sleep(every).await;
                    Some((Ok::<_, Infallible>(Bytes::from(frame)), ()))
                }
            });
            Some(event_stream(Body::from_stream(words)))
        }
        Pace::HeadersThenSilence(silence) => Some(late_answer(&model, &chat.answer, None, silence)),
        Pace::RoleChunkThenSilence(silence) => {
            let role = frame(&model, &json!({"role": "assistant"}), &Value::Null);
            Some(late_answer(&model, &chat.answer, Some(role), silence))
        }
    }
}

/// `opening` at once, then `silence`, then the whole answer and its end.
fn late_answer(
    model: &str,
    answer: &str,
    opening: Option<String>,
    silence: Duration,
) -> Response<Body> {
    let mut rest: Vec<String> = answer
        .split_inclusive(' ')
        .map(|word| chunk(model, word))
        .collect();
    rest.push(frame(model, &json!({}), &json!("stop")));
    rest.push("data: [DONE]\n\n".to_owned());
    let head = stream::iter(opening.map(|text| Ok::<_, Infallible>(Bytes::from(text))));
    let tail = stream::once(async move {
        tokio::time::sleep(silence).await;
        Ok(Bytes::from(rest.concat()))
    });
    event_stream(Body::from_stream(head.chain(tail)))
}

fn chunk(model: &str, content: &str) -> String {
    frame(model, &json!({"content": content}), &Value::Null)
}

fn frame(model: &str, delta: &Value, finish: &Value) -> String {
    let event = json!({
        "id": "chatcmpl-e2e-paced", "object": "chat.completion.chunk", "created": 1_759_000_000,
        "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]
    });
    format!("data: {event}\n\n")
}

fn event_stream(body: Body) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(body)
        .unwrap_or_default()
}
