use super::*;

#[tokio::test]
async fn chat_optional_finish_reasons_deliver() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixtures().remove(3);
    for reason in [Some("stop"), None] {
        let content = json!({"choices":[{"delta":{"content":"Answer"},"finish_reason":reason}]});
        let trailing = json!({"choices":[{"delta":{},"finish_reason":null}]});
        let response = ResponseRecord {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            chunks: vec![butler_e2e::e2e::cassette::Chunk {
                delay_ms: 0,
                text: format!("data: {content}\n\ndata: {trailing}\n\ndata: [DONE]\n\n"),
            }],
        };
        let server = Server::new(vec![(response, false)]).await?;
        let report = invoke(&server, &fixture, 1, 1).await?;
        assert_eq!(report["results"][0]["text"], "Answer", "{report}");
        if let Some(reason) = reason {
            assert_eq!(
                report["results"][0]["raw"]["choices"][0]["finish_reason"],
                reason
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn gemini_prompt_feedback_is_blocked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = fixtures().remove(2);
    let body = json!({"promptFeedback":{"blockReason":"SAFETY"}});
    for streaming in [false, true] {
        let response = ResponseRecord {
            status: 200,
            headers: vec![(
                "content-type".into(),
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                }
                .into(),
            )],
            chunks: vec![butler_e2e::e2e::cassette::Chunk {
                delay_ms: 0,
                text: if streaming {
                    format!("data: {body}\n\n")
                } else {
                    body.to_string()
                },
            }],
        };
        let server = Server::new(vec![(response, false)]).await?;
        let report = invoke(&server, &fixture, 1, 1).await?;
        assert_eq!(
            report["results"][0],
            json!({"error":"provider_safety_error","retryable":false})
        );
    }
    Ok(())
}
