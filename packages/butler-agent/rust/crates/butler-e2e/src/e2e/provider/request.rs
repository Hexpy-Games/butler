//! Local provider request routing.
use super::*;
pub(super) async fn handle(state: Arc<State>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    if parts.method == axum::http::Method::GET && path == "/v1/models" {
        let authority = lock(&state.authority).clone();
        if let Some(authority) = authority {
            let mut http = reqwest::Client::new().get(format!("{authority}/v1/models"));
            if let Some(auth) = parts.headers.get("authorization") {
                http = http.header("authorization", auth);
            }
            if let Ok(response) = http.send().await {
                let status = response.status().as_u16();
                let bytes = response.bytes().await.unwrap_or_default();
                return Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(Body::from(bytes))
                    .unwrap_or_default();
            }
        }
        if let Mode::Record {
            upstream, client, ..
        } = &state.mode
        {
            return budget::forward_models(&state, upstream, client, &parts.headers).await;
        }
        return plain(503, "HARNESS_ERROR: model authority unavailable");
    }
    let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let arrived = Instant::now();
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let chatgpt = match &state.mode {
        Mode::Replay(c) => c.meta.provider == "openai-subscription",
        Mode::Synthetic(_) => true,
        Mode::Record { meta, .. } => meta.provider == "openai-subscription",
    };
    if chatgpt
        && let Err(violation) =
            super::super::chatgpt_wire::assert_http(&parts.method, &path, &parts.headers, &json)
    {
        lock(&state.misses).push(format!("wire:{violation}"));
        return plain(501, &format!("HARNESS_ERROR: wire:{violation}"));
    }
    let memory = memory::matches(&json);
    if is_smart_group_request(&json) && !matches!(&state.mode, Mode::Record { .. }) {
        return smart_group(&state, json);
    }
    if let Mode::Synthetic(synthetic) = &state.mode
        && !is_title_request(&json)
    {
        if memory {
            return replay(&state, &memory::response(), None);
        }
        // A registered hold applies here too: the request is visible while it waits.
        let hold = take_hold(&state, &path, &json);
        let held = hold.is_some();
        if held {
            lock(&state.requests).push(json.clone());
        }
        if let Some(hold) = hold {
            let _ = hold.await;
        }
        let response = synthetic.respond(&json, bytes.len(), arrived);
        if !held {
            lock(&state.requests).push(json);
        }
        return response;
    }
    if memory && matches!(&state.mode, Mode::Replay(_)) {
        lock(&state.memory_requests).push(json.clone());
    } else {
        *lock(&state.served) += 1;
    }
    if !memory && matches!(&state.mode, Mode::Replay(_)) {
        lock(&state.requests).push(json.clone());
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
                lock(&state.requests).push(json);
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
            if !budget::admit_response(&state, &key) {
                return plain(501, "HARNESS_ERROR: record budget refused this request");
            }
            lock(&state.requests).push(json);
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

/// The hold registered for this request, if any; the match key is only built
/// when a hold is waiting, so unheld traffic pays nothing for it.
fn take_hold(
    state: &State,
    path: &str,
    json: &Value,
) -> Option<tokio::sync::oneshot::Receiver<()>> {
    if lock(&state.holds).is_empty() {
        return None;
    }
    let key = matching::key(path, json, &lock(&state.placeholders));
    lock(&state.holds).take(&key)
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

/// Replay and synthetic modes answer classification from the scenario's
/// responder, or file nothing.
fn smart_group(state: &State, json: Value) -> Response<Body> {
    let response = lock(&state.smart_group_responder)
        .and_then(|respond| respond(&json))
        .unwrap_or_else(|| smart_group_response(NO_SMART_GROUP));
    lock(&state.smart_group_requests).push(json);
    replay(state, &response, None)
}
