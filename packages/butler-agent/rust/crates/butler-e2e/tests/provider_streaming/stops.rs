use super::*;

#[tokio::test]
async fn stop_allowlists_reject_unknown_and_missing_reasons() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (index, path, reasons) in [
        (
            0,
            "/stop_reason",
            vec![
                "end_turn",
                "tool_use",
                "stop_sequence",
                "max_tokens",
                "model_context_window_exceeded",
                "pause_turn",
                "refusal",
            ],
        ),
        (1, "/status", vec!["completed"]),
        (
            2,
            "/candidates/0/finishReason",
            vec![
                "STOP",
                "MAX_TOKENS",
                "SAFETY",
                "RECITATION",
                "BLOCKLIST",
                "PROHIBITED_CONTENT",
                "SPII",
                "IMAGE_SAFETY",
            ],
        ),
        (
            3,
            "/choices/0/finish_reason",
            vec![
                "stop",
                "tool_calls",
                "function_call",
                "length",
                "content_filter",
            ],
        ),
    ] {
        for reason in reasons
            .into_iter()
            .map(Some)
            .chain([Some("future_reason"), None])
        {
            let fixture = fixtures().remove(index);
            let mut value = fixture["expected"].clone();
            *value.pointer_mut(path).unwrap() = reason.map_or(Value::Null, Value::from);
            let response = ResponseRecord {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                chunks: vec![butler_e2e::e2e::cassette::Chunk {
                    delay_ms: 0,
                    text: value.to_string(),
                }],
            };
            let server = Server::new(vec![(response, false)]).await?;
            let report = invoke(&server, &fixture, 1, 1).await?;
            let result = &report["results"][0];
            let error = match reason {
                Some("refusal") => Some("provider_response_refused"),
                Some(
                    "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
                    | "IMAGE_SAFETY" | "content_filter",
                ) => Some("provider_safety_error"),
                Some("model_context_window_exceeded") => Some("provider_context_limit_exceeded"),
                Some("future_reason") => Some("provider_stop_unrecognized"),
                None if index != 3 => Some("provider_stop_unrecognized"),
                _ => None,
            };
            if let Some(code) = error {
                assert_eq!(
                    result,
                    &json!({"error":code,"retryable":code == "provider_stop_unrecognized"}),
                    "{index} {reason:?}"
                );
            } else {
                assert_eq!(result["raw"], value, "{index} {reason:?}");
                assert_eq!(
                    result["outputTruncated"],
                    matches!(reason, Some("max_tokens" | "MAX_TOKENS" | "length"))
                );
            }
        }
    }
    Ok(())
}
