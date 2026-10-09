//! Local provider request routing.
use super::*;
pub(super) async fn handle(state: Arc<State>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let arrived = Instant::now();
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let memory = memory::matches(&json);
    if let Mode::Synthetic(synthetic) = &state.mode
        && !is_title_request(&json)
    {
        if memory {
            return replay(&state, &memory::response(), None);
        }
        let response = synthetic.respond(&json, bytes.len(), arrived);
        state.record_request(json);
        return response;
    }
    if memory && matches!(&state.mode, Mode::Replay(_)) {
        lock(&state.memory_requests).push(json.clone());
    } else {
        *lock(&state.served) += 1;
    }
    if !memory && matches!(&state.mode, Mode::Replay(_)) {
        state.record_request(json.clone());
    }
    learn_echo_ids(&state, &String::from_utf8_lossy(&bytes));
    let key = matching::key(&path, &json, &lock(&state.placeholders));
    let hold = lock(&state.holds).take(&key);
    if let Some(hold) = hold {
        let _ = hold.await;
    }
    match &state.mode {
        Mode::Synthetic(synthetic) => {
            if is_title_request(&json) {
                state.record_request(json);
                let fault = take_fault(&state, None, &key);
                replay(&state, &title_response("A Concise Chat Title"), fault)
            } else {
                synthetic.respond(&json, bytes.len(), arrived)
            }
        }
        Mode::Replay(cassette) => replay_request(&state, cassette, &json, &key, memory),
        Mode::Record {
            base: Some(base), ..
        } if base
            .exchanges
            .iter()
            .any(|exchange| exchange.request.key == key) =>
        {
            replay_recorded(&state, base, &key)
                .unwrap_or_else(|| plain(501, "HARNESS_ERROR: base recording lost"))
        }
        Mode::Record {
            upstream, client, ..
        } => {
            record(
                &state,
                upstream,
                client,
                &parts.method,
                &parts.headers,
                path,
                key,
                bytes,
            )
            .await
        }
    }
}

fn replay_request(
    state: &State,
    cassette: &Cassette,
    json: &Value,
    key: &cassette::MatchKey,
    memory: bool,
) -> Response<Body> {
    if !memory && let Some(response) = lock(&state.chat_responder).and_then(|respond| respond(json))
    {
        return replay(state, &response, None);
    }
    if let Some(response) = replay_recorded(state, cassette, key) {
        return response;
    }
    if is_title_request(json) {
        let fault = take_fault(state, None, key);
        return replay(state, &title_response("A Concise Chat Title"), fault);
    }
    if memory {
        let response = lock(&state.memory_responder)
            .map_or_else(memory::response, |responder| responder(json));
        return replay(state, &response, None);
    }
    // A declared stall may target a request whose live round was
    // cut off by a crash during recording: hold it open, answer nothing.
    if let Some((_, Transform::StallAfter(0))) = take_fault(state, None, key) {
        return replay(
            state,
            &ResponseRecord {
                status: 200,
                headers: Vec::new(),
                chunks: Vec::new(),
            },
            Some((usize::MAX, Transform::StallAfter(0))),
        );
    }
    lock(&state.misses).push(serde_json::to_string(key).unwrap_or_default());
    plain(501, "HARNESS_ERROR: no recording matches this request")
}
