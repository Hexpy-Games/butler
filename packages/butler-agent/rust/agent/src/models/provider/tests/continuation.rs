use super::*;
use serde_json::Value;

fn reference(id: &str) -> crate::btcc::OperationResultReference {
    serde_json::from_value(serde_json::json!({
        "version":"butler.operation-result-reference.v1",
        "kind":"operation_result",
        "identity":{"kind":"direct","result_ref":id,"tool_name":"tool"},
        "integrity":{"sha256":"a".repeat(64),"revision":null},
        "outcome":{"status":"completed","success":true,"verification":"stored_exact_available"},
        "availability":{"status":"exact_read_available","capability":"read_operation_results","scope":"same_turn"}
    })).unwrap()
}

fn message(role: ModelRoundRole, content: &str, call_id: Option<&str>) -> ModelRoundMessage {
    ModelRoundMessage {
        role,
        content: content.into(),
        tool_call_id: call_id.map(str::to_owned),
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    }
}

#[test]
fn legacy_projection_acknowledges_then_strips_only_images_after_success() {
    let mut acknowledged = message(ModelRoundRole::Tool, "compact-ref", Some("old-call"));
    acknowledged.operation_result_reference = Some(reference("ref-1"));
    let messages = [
        message(ModelRoundRole::User, "old user", None),
        acknowledged,
        message(ModelRoundRole::User, "new user", None),
        message(ModelRoundRole::Tool, "new output", Some("new-call")),
    ];
    let previous = serde_json::json!({
        "provider":"openai",
        "responseId":"resp-old",
        "sent":{"toolMessages":1,"userMessages":1},
        "statelessInput":[
            {"role":"user","content":[{"type":"input_text","text":"old user"}]},
            {"type":"function_call_output","call_id":"old-call","output":[
                {"type":"input_text","text":"keep"},
                {"type":"input_image","image_url":"private"},
                {"future":"kept"}
            ],"unknown":7},
            {"type":"function_call_output","call_id":"unacknowledged","output":[
                {"type":"input_text","text":"keep"},
                {"type":"input_image","image_url":"private"},
                {"future":"kept"}
            ]},
            {"type":"future_item","opaque":{"x":1}}
        ]
    });
    let mut input = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    input.continuation = Some(&previous);
    let projection = crate::models::provider::continuation::prepare(&input)
        .unwrap()
        .unwrap();

    assert_eq!(
        projection.request_items,
        serde_json::json!([
            {"role":"user","content":[{"type":"input_text","text":"new user"}]},
            {"type":"function_call_output","call_id":"new-call","output":"new output"}
        ])
    );
    assert_eq!(
        projection.successful.stateless_request_input[1]["output"],
        "compact-ref"
    );
    assert_eq!(
        previous.pointer("/statelessInput/1/output/1/type").unwrap(),
        "input_image"
    );
    let (_, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let mut config = super::serialization::carrier_config(metadata, "gpt-5.5");
    let (official, _) =
        serialize::body_with_continuation(&input, &config, serialize::Carrier::Responses).unwrap();
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/legacy-continuation.json")).unwrap();
    assert_eq!(official["input"], golden["wireInput"]);
    config.auth = ProviderAuth::Codex {
        mode: ProviderAuthMode::CodexSubscription,
        authorization: "Bearer fixture".into(),
        account_id: "account".into(),
        user_agent: "Butler fixture".into(),
        originator: "butler".into(),
    };
    let (codex, _) =
        serialize::body_with_continuation(&input, &config, serialize::Carrier::Responses).unwrap();
    assert_eq!(
        codex["input"],
        Value::Array(projection.successful.stateless_request_input.clone())
    );

    let response = serde_json::json!({"id":"resp-new","output":[
        {"type":"function_call","call_id":"fresh","name":"next","arguments":"{}"},
        {"type":"message","content":[]}
    ]});
    let result = result::decode(
        response,
        "openai",
        "openai/gpt-5.5",
        serialize::Carrier::Responses,
        0,
        &input,
        Some(projection.successful),
    );
    let continuation = result.continuation.unwrap();
    assert_eq!(continuation, golden["next"]);
    assert_eq!(
        continuation["sent"],
        serde_json::json!({"toolMessages":2,"userMessages":2})
    );
    let next = continuation["statelessInput"].as_array().unwrap();
    assert_eq!(next[1]["unknown"], 7);
    assert_eq!(next[1]["output"], "compact-ref");
    assert_eq!(
        next[3],
        serde_json::json!({"type":"future_item","opaque":{"x":1}})
    );
    assert_eq!(
        next[2]["output"],
        serde_json::json!([
            {"type":"input_text","text":"keep"},
            {"future":"kept"}
        ])
    );
    assert_eq!(next.last().unwrap()["call_id"], "fresh");
}

#[test]
fn bounded_and_failed_legacy_rounds_do_not_mutate_prior_continuation() {
    let messages = [message(ModelRoundRole::User, "hello", None)];
    let prior = serde_json::json!({
        "provider":"openai", "responseId":"old",
        "sent":{"toolMessages":0,"userMessages":1},
        "statelessInput":[{"opaque":true}]
    });
    let unchanged = prior.clone();
    let mut legacy = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    legacy.continuation = Some(&prior);
    drop(crate::models::provider::continuation::prepare(&legacy).unwrap());
    assert_eq!(prior, unchanged);

    let bounded = serde_json::json!({"responseItemId":"turn-item-1"});
    legacy.bounded_continuation = Some(&bounded);
    assert!(
        crate::models::provider::continuation::prepare(&legacy)
            .unwrap()
            .is_none()
    );
}

#[test]
fn acknowledgement_uses_last_nonempty_matching_call_id() {
    let mut first = message(ModelRoundRole::Tool, "first", Some("duplicate"));
    first.operation_result_reference = Some(reference("one"));
    let mut last = message(ModelRoundRole::Tool, "last", Some("duplicate"));
    last.operation_result_reference = Some(reference("two"));
    let mut empty = message(ModelRoundRole::Tool, "must-not-project", Some(""));
    empty.operation_result_reference = Some(reference("empty"));
    let messages = [first, last, empty];
    let prior = serde_json::json!({
        "provider":"openai", "responseId":"old",
        "sent":{"toolMessages":0,"userMessages":0},
        "statelessInput":[
            {"type":"function_call_output","call_id":"duplicate","output":"old"},
            {"type":"function_call_output","call_id":"","output":"empty-old"}
        ]
    });
    let mut input = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    input.continuation = Some(&prior);
    let prepared = crate::models::provider::continuation::prepare(&input)
        .unwrap()
        .unwrap();
    assert_eq!(
        prepared.successful.stateless_request_input[0]["output"],
        "last"
    );
    assert_eq!(
        prepared.successful.stateless_request_input[1]["output"],
        "empty-old"
    );
}

#[tokio::test]
async fn transport_failure_and_preflight_cancel_leave_prior_legacy_state_unchanged() {
    let body = br#"{"error":{"message":"temporary"}}"#;
    let response = format!(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (endpoint, server) = super::transport::retry_server(vec![response]).await;
    let (provider, _) = super::transport::provider(endpoint, "openai/gpt-5.5");
    let messages = [message(ModelRoundRole::User, "hello", None)];
    let prior = serde_json::json!({
        "provider":"openai", "responseId":"old",
        "sent":{"toolMessages":0,"userMessages":1},
        "statelessInput":[{"opaque":true}]
    });
    let unchanged = prior.clone();
    let mut failed = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    failed.continuation = Some(&prior);
    assert!(provider.run_round(failed).await.is_err());
    server.await.unwrap();
    assert_eq!(prior, unchanged);

    let (provider, _) = super::transport::provider(
        Url::parse("http://127.0.0.1:1/v1/responses").unwrap(),
        "openai/gpt-5.5",
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let mut cancelled = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        cancellation,
        None,
    );
    cancelled.continuation = Some(&prior);
    assert!(matches!(
        provider.run_round(cancelled).await,
        Err(ModelRoundError::Cancelled)
    ));
    assert_eq!(prior, unchanged);
}
