use super::*;
use std::fmt::Write as _;

#[tokio::test]
async fn anthropic_truncated_tool_arguments_feed_back_to_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fragment = "{\"path\":\"unfinished";
    let events = [
        json!({"type":"message_start","message":{"id":"msg-cut","role":"assistant","content":[],"usage":{"input_tokens":10}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-cut","name":"read_file","input":{}}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":fragment}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8}}),
        json!({"type":"message_stop"}),
    ];
    let mut fixture = fixtures().remove(0);
    fixture["shape"] = "anthropic-recovery".into();
    let mut response: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
    let mut body = String::new();
    for event in events {
        write!(body, "data: {event}\n\n").unwrap();
    }
    response.chunks[0].text = body;
    let final_response = ResponseRecord {
        status: 200, headers: vec![("content-type".into(), "application/json".into())],
        chunks: vec![butler_e2e::e2e::cassette::Chunk { delay_ms: 0,
            text: json!({"stop_reason":"end_turn","content":[{"type":"text","text":"Recovered"}],"usage":{"input_tokens":20,"output_tokens":2}}).to_string() }],
    };
    let server = Server::new(vec![(response, false), (final_response, false)]).await?;
    let report = invoke(&server, &fixture, 2, 1).await?;
    let call = &report["results"][0]["toolCalls"][0];
    assert_eq!(call["rawArguments"], fragment);
    assert_eq!(call["arguments"], json!({}));
    assert_eq!(report["results"][0]["raw"]["stop_reason"], "max_tokens");
    assert_eq!(report["results"][1]["text"], "Recovered");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let (_, body) = requests[1].split_once("\r\n\r\n").unwrap();
    let body: Value = serde_json::from_str(body)?;
    let messages = body["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_use"
                    && b["id"] == "call-cut"
                    && b["input"] == json!({}))))
    );
    assert!(
        messages.iter().any(|m| m["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"
                && b["tool_use_id"] == "call-cut"
                && b["content"].to_string().contains("output_truncated"))))
    );
    Ok(())
}

#[tokio::test]
async fn chat_usage_option_rejection_retries_once_and_is_remembered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixtures().remove(3);
    let complete: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
    let mut refused = complete.clone();
    refused.status = 400;
    refused.headers[0].1 = "application/json".into();
    refused.chunks[0].text =
        json!({"error":{"message":"Unknown field","param":"stream_options"}}).to_string();
    let server = Server::new(vec![
        (refused, false),
        (complete.clone(), false),
        (complete.clone(), false),
    ])
    .await?;
    let report = invoke(&server, &fixture, 2, 1).await?;
    for result in report["results"].as_array().unwrap() {
        assert_eq!(result["raw"], fixture["expected"]);
        assert_eq!(
            result["usage"]["totalTokens"].as_f64(),
            fixture["expected"]["usage"]["total_tokens"].as_f64()
        );
    }
    let metrics = report["metrics"].as_array().unwrap();
    assert_eq!(metrics.len(), 3);
    assert_eq!(
        metrics[1]["totalTokens"],
        report["results"][0]["usage"]["totalTokens"]
    );
    assert_eq!(
        metrics[2]["totalTokens"],
        report["results"][1]["usage"]["totalTokens"]
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    for (index, request) in requests.iter().enumerate() {
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1)?;
        assert_eq!(body["stream"], true);
        assert_eq!(body.get("stream_options").is_some(), index == 0);
    }
    Ok(())
}

#[tokio::test]
async fn chat_without_reported_usage_records_estimate() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixtures().remove(3);
    let mut complete: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
    let body = complete.body();
    complete.chunks[0].text = body
        .split("\n\n")
        .filter(|frame| !frame.contains("\"choices\":[]"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut refused = complete.clone();
    refused.status = 400;
    refused.headers[0].1 = "application/json".into();
    refused.chunks[0].text = json!({"error":{"message":"Unsupported stream_options"}}).to_string();
    let server = Server::new(vec![(refused, false), (complete, false)]).await?;
    let report = invoke(&server, &fixture, 1, 1).await?;
    let result = &report["results"][0];
    assert_eq!(result["text"], fixture["expected_text"]);
    assert_eq!(result["toolCalls"].as_array().unwrap().len(), 2);
    assert_eq!(result["usage"]["source"], "estimate");
    assert_eq!(
        report["metrics"][1]["totalTokens"],
        result["usage"]["totalTokens"]
    );
    assert!(result["usage"]["promptTokens"].as_f64().unwrap() > 0.0);
    assert_eq!(result["usage"]["outputTokens"], 15.0);
    assert_eq!(
        result["usage"]["totalTokens"].as_f64().unwrap(),
        result["usage"]["promptTokens"].as_f64().unwrap()
            + result["usage"]["outputTokens"].as_f64().unwrap()
    );
    Ok(())
}

#[tokio::test]
async fn chat_usage_option_retry_is_bounded_and_other_errors_are_unchanged()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixtures().remove(3);
    for (status, message, count) in [
        (400, "Unknown stream_options", 2),
        (401, "Invalid credentials", 1),
    ] {
        let mut refused: ResponseRecord = serde_json::from_value(fixture["response"].clone())?;
        refused.status = status;
        refused.headers[0].1 = "application/json".into();
        refused.chunks[0].text = json!({"error":{"message":message}}).to_string();
        let server = Server::new(vec![(refused, false); count]).await?;
        let report = invoke(&server, &fixture, 1, 1).await?;
        assert_eq!(report["results"][0]["retryable"], false);
        assert_eq!(
            report["results"][0]["error"],
            if status == 400 {
                "provider_api_error"
            } else {
                "provider_auth_error"
            }
        );
        assert_eq!(server.requests.lock().unwrap().len(), count);
    }
    Ok(())
}
