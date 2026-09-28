use std::sync::Arc;

use serde_json::Value;

use super::*;

mod artifact_session;
mod support;

use support::*;

#[tokio::test]
async fn authenticated_message_route_preserves_validation_and_deferred_admission() {
    let application = Arc::new(TestApplication::default());
    let server = start(
        application.clone(),
        LocalAuthConfig::required(Some("secret".into())),
    )
    .await;

    let unauthorized = request(
        server.local_addr(),
        "POST /messages HTTP/1.1\r\nhost: localhost\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
    )
    .await;
    assert!(unauthorized.starts_with("HTTP/1.1 401 Unauthorized"));
    assert!(unauthorized.contains("Butler App local auth is required."));

    let malformed = request(
        server.local_addr(),
        "POST /messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer secret\r\ncontent-type: application/json\r\ncontent-length: 1\r\nconnection: close\r\n\r\n{",
    )
    .await;
    assert!(malformed.starts_with("HTTP/1.1 400 Bad Request"));
    assert!(malformed.contains("\"code\":\"invalid_json\""));

    let oversized = request(
        server.local_addr(),
        "POST /messages HTTP/1.1\r\nhost: localhost\r\ncontent-length: 134217729\r\nconnection: close\r\n\r\n",
    )
    .await;
    assert!(oversized.starts_with("HTTP/1.1 413 "));
    assert!(!oversized.contains("protocol_version"));

    let body = r#"{"chat_id":"  general  ","attachments":[{"file_id":"file-1"}],"authority_request_ref":"x"}"#;
    let forbidden = authorized_json(server.local_addr(), body).await;
    assert!(forbidden.starts_with("HTTP/1.1 400 Bad Request"));
    assert!(forbidden.contains("Authority decisions must use the Allow endpoint."));

    let content = r#"{"content_parts":{"version":1.0,"parts":[{"type":"session_ref","sessionId":"session-1","titleSnapshot":"Session"}]}}"#;
    let content_accepted = authorized_json(server.local_addr(), content).await;
    assert!(content_accepted.starts_with("HTTP/1.1 202 Accepted"));
    let content_command = application.last_message.lock().unwrap().take().unwrap();
    assert!(content_command.request.content_parts.is_some());
    assert!(content_command.request.text.is_none());

    let blank_content = r#"{"content_parts":{"version":1,"parts":[{"type":"text","text":"   "}]}}"#;
    let blank_rejected = authorized_json(server.local_addr(), blank_content).await;
    assert!(blank_rejected.starts_with("HTTP/1.1 400 Bad Request"));
    assert!(blank_rejected.contains("Message text is required."));

    let body = r#"{"chat_id":"  general  ","text":"hello","plan_mode":"downstream-validates"}"#;
    let accepted = authorized_json(server.local_addr(), body).await;
    assert!(accepted.starts_with("HTTP/1.1 202 Accepted"));
    assert!(accepted.contains("\"protocol_version\":\"butler.app.v1\""));
    assert!(accepted.contains("\"accepted\":{\"id\":\"message-1\""));
    let command = application.last_message.lock().unwrap().take().unwrap();
    assert_eq!(command.chat_id, "general");
    assert_eq!(
        command.request.plan_mode,
        Some(Value::String("downstream-validates".into()))
    );

    server.close().await.unwrap();
}

/// Security boundary: required auth without a token and the rate limit keep
/// their public errors.
// test-category: security
#[tokio::test]
async fn required_auth_without_token_and_rate_limit_keep_public_errors() {
    let application = Arc::new(TestApplication::default());
    let unconfigured = start(application.clone(), LocalAuthConfig::required(None)).await;
    let response = request(
        unconfigured.local_addr(),
        "GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
    assert!(response.contains("\"code\":\"local_auth_unconfigured\""));
    unconfigured.close().await.unwrap();

    let limited = start_with_config(
        application,
        GatewayConfig {
            message_rate_limit_max: 1,
            ..GatewayConfig::default()
        },
    )
    .await;
    let body = r#"{"text":"hello"}"#;
    assert!(
        authorized_json(limited.local_addr(), body)
            .await
            .starts_with("HTTP/1.1 202 Accepted")
    );
    let second = authorized_json(limited.local_addr(), body).await;
    assert!(second.starts_with("HTTP/1.1 429 Too Many Requests"));
    assert!(second.contains("Too many messages. Please wait before sending again."));
    limited.close().await.unwrap();
}
