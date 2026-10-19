use super::*;

fn frame(value: &Value) -> String {
    format!("data: {value}\n\n")
}
fn gemini(part: &Value, end: bool) -> String {
    let mut candidate = json!({"index":0,"content":{"role":"model","parts":[part]}});
    if end {
        candidate["finishReason"] = json!("STOP");
    }
    frame(&json!({"candidates":[candidate],"modelVersion":"gemini-3.8-flash"}))
}
fn frames(stub: &Stub, first_index: u64, second_index: u64) -> (String, String, String) {
    let gap = if stub.provider == "openai" { "\n\n" } else { "\n" };
    let a = format!("**{FIRST}**{gap}Details.\n");
    let b = format!("**{SECOND}**{gap}More details.\n");
    match stub.provider {
        "google" => (
            gemini(&json!({"text":a,"thought":true}), false),
            gemini(&json!({"text":b,"thought":true}), false),
            gemini(
                &json!({"functionCall":{"name":"tool_describe","args":{"ids":["native:list_tool_capabilities"]}},"thoughtSignature":SIGNATURE}),
                false,
            ) + &frame(
                &json!({"candidates":[{"index":0,"finishReason":"STOP"}],"modelVersion":"gemini-3.8-flash"}),
            ),
        ),
        "anthropic" => (
            frame(
                &json!({"type":"message_start","message":{"id":"msg_thinking","model":"claude-haiku-4-5","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}),
            ) + &frame(
                &json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            ) + &frame(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":a}}),
            ),
            frame(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":b}}),
            ),
            frame(
                &json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":SIGNATURE}}),
            ) + &frame(&json!({"type":"content_block_stop","index":0}))
                + &frame(
                    &json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
                )
                + &frame(
                    &json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}),
                )
                + &frame(&json!({"type":"content_block_stop","index":1}))
                + &frame(
                    &json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}),
                )
                + &frame(&json!({"type":"message_stop"})),
        ),
        _ => {
            let kind = if stub.raw {
                "response.reasoning_text.delta"
            } else {
                "response.reasoning_summary_text.delta"
            };
            (
                summary_part(kind, first_index, a.trim_end()),
                summary_part(kind, second_index, b.trim_end()),
                frame(&json!({"type":"response.output_text.delta","delta":"Done."}))
                    + &frame(
                        &json!({"type":"response.completed","response":{"id":"resp_done","model":"gpt-5.5","status":"completed","output":[{"type":"reasoning","summary":if stub.raw { json!([]) } else { json!([
                            {"type":"summary_text","text":"unfinished\n- **A** [link](https://example.org)\npartial"},
                            {"type":"summary_text","text":format!("**{}**", "😀".repeat(80))},
                            {"type":"summary_text","text":format!("{}\nExtra body.\n", a.trim_end())},
                            {"type":"summary_text","text":"**Superseded**\nBody."},
                            {"type":"summary_text","text":b.trim_end()}
                        ]) }},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}],"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}}}),
                    ),
            )
        }
    }
}
async fn reply(State(stub): State<Stub>, Json(body): Json<Value>) -> Response {
    if stub.reject_summary && body["reasoning"]["summary"] == "auto" {
        stub.requests.lock().unwrap().push(body);
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","param":"reasoning.summary","message":"Summary unavailable"}}))).into_response();
    }
    let round = {
        let mut requests = stub.requests.lock().unwrap();
        requests.push(body);
        requests.len()
    };
    if stub.provider == "google" && round > 1 {
        return (
            [("content-type", "text/event-stream")],
            (if stub
                .final_summary
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                gemini(
                    &json!({"text":"**Finishing the answer**\nFinal details.\n","thought":true}),
                    false,
                )
            } else {
                String::new()
            }) + &gemini(&json!({"text":"Done."}), true),
        )
            .into_response();
    }
    let checks = stub.provider == "openai" && !stub.raw && !stub.reject_summary;
    let (first, second, last) = frames(
        &stub,
        if checks { 2 } else { 0 },
        if checks { 4 } else { 1 },
    );
    let chunks = if checks {
        vec![
            (
                0,
                summary_part("response.reasoning_summary_text.delta", 0, "unfinished"),
            ),
            (
                300,
                frame(
                    &json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"\n- **A** [link](https://example.org)\npartial"}),
                ),
            ),
            (
                1100,
                summary_part(
                    "response.reasoning_summary_text.delta",
                    1,
                    &format!("**{}**", "😀".repeat(80)),
                ),
            ),
            (2100, first),
            (
                300,
                frame(
                    &json!({"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"\nExtra body.\n"}),
                ),
            ),
            (
                100,
                summary_part(
                    "response.reasoning_summary_text.delta",
                    3,
                    "**Superseded**\nBody.",
                ),
            ),
            (200, second),
        ]
    } else {
        vec![(0, first), (300, second)]
    };
    let (start, terminal) = last.rsplit_once("data:").unwrap();
    let (start, terminal) = (start.to_owned(), format!("data:{terminal}"));
    let chunks = chunks
        .into_iter()
        .map(|(delay, text)| (Some(delay), text))
        .chain([(None, start), (None, terminal)]);
    let stream = futures_util::stream::unfold(
        (chunks, stub, false),
        |(mut chunks, stub, finishing)| async move {
            let (delay, text) = chunks.next()?;
            let finishing = if let Some(delay) = delay {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                finishing
            } else if finishing {
                if text.is_empty() {
                    return None;
                }
                stub.finish_gate.notified().await;
                true
            } else {
                stub.gate.notified().await;
                true
            };
            Some((
                Ok::<_, std::convert::Infallible>(text),
                (chunks, stub, finishing),
            ))
        },
    );
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}

pub(super) async fn setup(
    provider: &'static str,
    raw: bool,
) -> Result<(Scenario, Stub, Server), HarnessError> {
    setup_refusal(provider, raw, false).await
}
pub(super) async fn setup_refusal(
    provider: &'static str,
    raw: bool,
    reject_summary: bool,
) -> Result<(Scenario, Stub, Server), HarnessError> {
    let stub = Stub {
        provider,
        raw,
        reject_summary,
        gate: Arc::new(Notify::new()),
        finish_gate: Arc::new(Notify::new()),
        requests: Default::default(),
        final_summary: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let model = match provider {
        "google" => "gemini-3.8-flash",
        "anthropic" => "claude-haiku-4-5",
        _ => "gpt-5.5",
    };
    let app = Router::new().route("/v1/models", get(|| async { Json(json!({"data":[],"models":[{"name":"models/gemini-3.8-flash","displayName":"Gemini 3.8 Flash","supportedGenerationMethods":["generateContent"],"inputTokenLimit":1_048_576,"outputTokenLimit":65_536}]})) }))
        .route("/v1/models/gemini-3.8-flash:streamGenerateContent", post(reply))
        .route("/v1/messages", post(reply)).route("/v1/responses", post(reply)).with_state(stub.clone());
    let server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let env = match provider {
        "google" => "BUTLER_GOOGLE_BASE_URL",
        "anthropic" => "BUTLER_ANTHROPIC_BASE_URL",
        _ => "OPENAI_BASE_URL",
    };
    let s = Setup::new("MODEL-THINKING")?
        .env(env, &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let key = match provider {
        "google" => "AIza-e2e-placeholder",
        "anthropic" => "sk-ant-e2e-placeholder",
        _ => "sk-e2e-placeholder",
    };
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":provider,"api_key":key}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered = s.gw.post("/model-catalog/registered-models", json!({"provider_id":provider,"model_id":model,"auth_type":"api_key","credential_id":saved.data()["credential"]["id"]})).await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: format!("{provider}/{model}"),
            effort: Some("medium".into()),
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    stub.requests.lock().unwrap().clear();
    Ok((s, stub, server))
}

fn summary_part(kind: &str, index: u64, text: &str) -> String {
    frame(
        &json!({"type":"response.reasoning_summary_part.added","item_id":"rs_1","output_index":0,"summary_index":index,"part":{"type":"summary_text","text":""}}),
    ) + &frame(
        &json!({"type":kind,"item_id":"rs_1","output_index":0,"summary_index":index,"delta":text}),
    )
}
