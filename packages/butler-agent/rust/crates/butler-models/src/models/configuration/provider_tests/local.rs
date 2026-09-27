use std::time::Duration;

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::*;

async fn accept_discovery(listener: TcpListener, expected_auth: &[bool]) {
    for expected in expected_auth {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let count = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let headers = String::from_utf8_lossy(&bytes[..count]).to_ascii_lowercase();
        assert_eq!(
            headers.contains("authorization: bearer saved-local-key"),
            *expected
        );
        let body = r#"{"data":[{"id":"org/model"}]}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn discovery_reuses_saved_key_only_for_exact_endpoint_and_explicit_empty_wins() {
    let same_endpoint = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_address = same_endpoint.local_addr().unwrap();
    let other_endpoint = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_address = other_endpoint.local_addr().unwrap();
    let same_server = tokio::spawn(accept_discovery(same_endpoint, &[true, false]));
    let other_server = tokio::spawn(accept_discovery(other_endpoint, &[false]));

    let fixture = Fixture::new("local-discovery-auth");
    fixture.write(
        "butler.config.json",
        &json!({"models":{"local":[{
            "model_id":"org/model", "model_ref":"local/org-model",
            "server_url":format!("http://{first_address}/gateway/v1"),
            "api_base_url":format!("http://{first_address}/gateway/v1"),
            "context_window_tokens":4096
        }]}}),
    );
    fixture.write(
        "auth/custom-model-credentials.json",
        &json!({"local/org-model":"saved-local-key"}),
    );
    let owner = fixture.owner(ModelConfigurationEnvironment::default());
    let model_ref = Some("local/org-model");

    let first_url = format!("http://{first_address}/gateway/v1");
    owner
        .discover_local_models(
            &first_url,
            crate::models::LocalModelPlatform::Custom,
            model_ref,
            None,
            Some(&fixture.0),
        )
        .await
        .unwrap();
    owner
        .discover_local_models(
            &first_url,
            crate::models::LocalModelPlatform::Custom,
            model_ref,
            Some(""),
            Some(&fixture.0),
        )
        .await
        .unwrap();
    owner
        .discover_local_models(
            &format!("http://{second_address}/gateway/v1"),
            crate::models::LocalModelPlatform::Custom,
            model_ref,
            None,
            Some(&fixture.0),
        )
        .await
        .unwrap();

    same_server.await.unwrap();
    other_server.await.unwrap();
}
