use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::*;

#[tokio::test]
async fn loopback_discovery_uses_models_and_per_model_props_with_fallbacks() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut paths = Vec::new();
        let mut authenticated = Vec::new();
        for _ in 0..5 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let size = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            let path = request.split_whitespace().nth(1).unwrap().to_owned();
            authenticated.push(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer discovery-key"),
            );
            let body = if path == "/v1/models" {
                r#"{"data":[{"id":"model-one.gguf"},{"model":"model-two","context_length":4096},{"id":"fractional","status":{"args":["--ctx-size","0.5"]},"context_length":4096},{"id":"binary","status":{"args":["-c","0b1000"]}}]}"#
            } else if path.contains("model-one.gguf") {
                r#"{"default_generation_settings":{"n_ctx":32768}}"#
            } else {
                "{}"
            };
            paths.push(path);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
        (paths, authenticated)
    });
    let result = discover(
        &crate::models::provider_http_client().unwrap(),
        &address.to_string(),
        LocalModelPlatform::LlamaCpp,
        Some("discovery-key"),
    )
    .await
    .unwrap();
    assert_eq!(result.server_url, format!("http://{address}"));
    assert_eq!(result.models[0].model_id, "model-one.gguf");
    assert_eq!(result.models[0].display_name, "model one");
    assert_eq!(result.models[0].context_window_tokens, 32_768.0);
    assert_eq!(result.models[1].context_window_tokens, 4_096.0);
    assert_eq!(result.models[2].context_window_tokens, 0.0);
    assert_eq!(result.models[3].context_window_tokens, 8.0);
    let (paths, authenticated) = server.await.unwrap();
    assert_eq!(paths[0], "/v1/models");
    assert!(paths[1].starts_with("/props?model=model-one.gguf"));
    assert!(paths[2].starts_with("/props?model=model-two"));
    assert!(authenticated.into_iter().all(|value| value));
    assert_eq!(result.models[0].provider_label, "Custom");
}

#[tokio::test]
async fn fetch_object_accepts_response_larger_than_four_megabytes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let body = serde_json::json!({"padding":"x".repeat(4 * 1024 * 1024 + 1)}).to_string();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    let value = fetch_object(
        &crate::models::provider_http_client().unwrap(),
        &format!("http://{address}/large"),
        None,
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(
        value["padding"].as_str().map(str::len),
        Some(4 * 1024 * 1024 + 1)
    );
}

#[tokio::test]
async fn custom_discovery_preserves_raw_ids_and_skips_llama_props() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        let size = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..size]);
        assert!(request.starts_with("GET /gateway/v1/models HTTP/1.1\r\n"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer custom-key")
        );
        let body = r#"{"data":[{"id":"org/model.gguf","context_length":8192}]}"#;
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
    });
    let result = discover(
        &crate::models::provider_http_client().unwrap(),
        &format!("http://{address}/gateway/v1/"),
        LocalModelPlatform::Custom,
        Some("custom-key"),
    )
    .await
    .unwrap();
    server.await.unwrap();
    assert_eq!(result.api_base_url, format!("http://{address}/gateway/v1"));
    assert_eq!(result.models[0].model_id, "org/model.gguf");
    assert_eq!(result.models[0].model_ref, "local/org-model.gguf");
    assert_eq!(result.models[0].context_window_tokens, 8_192.0);
}
