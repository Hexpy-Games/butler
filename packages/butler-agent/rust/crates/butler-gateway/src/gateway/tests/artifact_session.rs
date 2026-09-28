use super::*;
use std::sync::Arc;

mod fixtures;
use fixtures::{artifact_request, test_db_path};
pub(super) use fixtures::{open_app, start_real};

#[tokio::test]
async fn artifacts_route_projects_attachment_and_survives_app_reopen() {
    let path = test_db_path();
    let application = Arc::new(open_app(&path).await);
    crate::gateway::application::seed_test_assistant_attachment(
        &application,
        "general",
        "message-artifact",
        "file-artifact",
    )
    .await
    .unwrap();

    let server = start_real(application.clone()).await;
    let first = artifact_request(server.local_addr()).await;
    assert!(first.starts_with("HTTP/1.1 200 OK"));
    assert!(first.contains("\"protocol_version\":\"butler.app.v1\""));
    assert!(first.contains("\"artifacts\":[{"));
    assert!(first.contains("\"id\":\"artifact-file-artifact\""));
    assert!(first.contains("\"session_id\":\"general\""));
    assert!(first.contains("\"message_id\":\"message-artifact\""));
    assert!(first.contains("\"file_id\":\"file-artifact\""));
    assert!(first.contains("\"kind\":\"image\""));
    assert_eq!(first.matches("\"file_id\":\"file-artifact\"").count(), 1);
    server.close().await.unwrap();
    application.close().await.unwrap();

    let reopened = Arc::new(open_app(&path).await);
    let server = start_real(reopened.clone()).await;
    let second = artifact_request(server.local_addr()).await;
    assert!(second.starts_with("HTTP/1.1 200 OK"));
    assert!(second.contains("\"id\":\"artifact-file-artifact\""));
    assert!(second.contains("\"file_id\":\"file-artifact\""));
    server.close().await.unwrap();
    reopened.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn provider_usage_reaches_public_context_details_route() {
    let path = test_db_path();
    let application = Arc::new(open_app(&path).await);
    let server = start_real(application.clone()).await;
    let response = request(
        server.local_addr(),
        "GET /context-details?session_id=general HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    ).await;
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(response.contains("\"token_count_source\":\"provider_prompt_usage\""));
    assert!(response.contains("\"used_tokens\":1234"));
    assert!(response.contains("\"source_kind\":\"output_reserve\""));
    for path in ["/session-view", "/session-summary"] {
        let response = request(
            server.local_addr(),
            &format!(
                "GET {path}?session_id=general HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("\"token_count_source\":\"provider_prompt_usage\""));
        assert!(response.contains("\"used_tokens\":1234"));
    }
    server.close().await.unwrap();
    application.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}
