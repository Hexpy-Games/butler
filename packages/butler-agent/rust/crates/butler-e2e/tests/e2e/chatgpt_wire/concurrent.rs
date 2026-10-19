use super::*;

pub(super) async fn reply(
    State(state): State<Arc<Mutex<Script>>>,
    Json(body): Json<Value>,
) -> Response {
    let (count, originals, retried) = {
        let mut state = state.lock().unwrap();
        let key = butler_e2e::e2e::matching::key("/v1/responses", &body, &Default::default());
        if !key
            .user_request
            .starts_with(&butler_e2e::e2e::matching::normalize_volatile(
                &state.marker,
            ))
        {
            return success();
        }
        state.requests.push(body.clone());
        (
            state.requests.len(),
            state.originals.clone(),
            state.retried.clone(),
        )
    };
    if body.pointer("/text/verbosity").is_some() {
        // Both original bodies must be serialized before either learns the removal.
        originals.wait().await;
        if count == 2 {
            // Deliver the second rejection only after the first round has applied the memo.
            retried.notified().await;
        }
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":{
                "code":"subscription_sharing_unsupported_capability","param":"text.verbosity"
            }})),
        )
            .into_response()
    } else {
        retried.notify_one();
        success()
    }
}

pub(super) async fn rounds() -> Result<(), HarnessError> {
    let stub = Stub::start("concurrent").await?;
    let s = stub.scenario("SIWC-12-CONCURRENT").await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Parallel round"}))
            .await?;
    assert_eq!(created.status, 201);
    let chat = created.data()["session"]["id"].as_str().unwrap();
    let marker = stub.marker();
    let (left, right) = tokio::join!(s.turn("general", &marker), s.turn(chat, &marker));
    assert_eq!(turn_state(&left?.1), "delivered");
    assert_eq!(turn_state(&right?.1), "delivered");
    let requests = stub.requests();
    assert_eq!(requests.len(), 4);
    assert!(
        requests[..2]
            .iter()
            .all(|body| body.pointer("/text/verbosity").is_some())
    );
    assert!(
        requests[2..]
            .iter()
            .all(|body| body.pointer("/text/verbosity").is_none())
    );
    s.finish().await
}
