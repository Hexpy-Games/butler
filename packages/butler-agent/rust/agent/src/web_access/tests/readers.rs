use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::web_access::WebAccess;

type Reply = (&'static str, Vec<u8>);

async fn serve(replies: Vec<Reply>) -> (String, JoinHandle<()>, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let paths = Arc::new(Mutex::new(Vec::new()));
    let captured = paths.clone();
    let task = tokio::spawn(async move {
        for (content_type, body) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2_048];
            let count = stream.read(&mut request).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..count]).into_owned();
            captured
                .lock()
                .unwrap()
                .push(request.lines().next().unwrap_or_default().into());
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        }
    });
    (format!("http://{address}/"), task, paths)
}

#[tokio::test]
async fn github_blob_retries_raw_and_returns_source_text() {
    let replies = vec![
        (
            "text/html",
            b"<html><body><p>Sign in to continue</p></body></html>".to_vec(),
        ),
        ("text/plain", b"fn main() { let answer = 42; }".to_vec()),
    ];
    let (endpoint, server, paths) = serve(replies).await;
    let root = super::data_root();
    let access = WebAccess::for_test_with_page_endpoint(
        root.clone(),
        "http://127.0.0.1:9/search",
        &endpoint,
    );
    let result = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://github.com/acme/demo/blob/main/src/main.rs"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["method"], "github-raw");
    assert_eq!(
        result["final_url"],
        "https://raw.githubusercontent.com/acme/demo/main/src/main.rs"
    );
    assert!(result["markdown"].as_str().unwrap().contains("answer = 42"));
    server.await.unwrap();
    let paths = paths.lock().unwrap();
    assert_eq!(paths.len(), 2);
    assert!(paths[0].contains("/github.com/acme/demo/blob/main/src/main.rs"));
    assert!(paths[1].contains("/raw.githubusercontent.com/acme/demo/main/src/main.rs"));
    drop(paths);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn pdf_uses_shared_extractor_and_jina_backend_falls_back_locally() {
    let pdf = include_bytes!("../../context/pdf/two-pages.pdf").to_vec();
    let (endpoint, server, _) = serve(vec![("application/pdf", pdf)]).await;
    let root = super::data_root();
    let access = WebAccess::for_test_with_page_endpoint(
        root.clone(),
        "http://127.0.0.1:9/search",
        &endpoint,
    );
    let result = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://example.com/paper.pdf"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["method"], "pdf");
    assert_eq!(result["title"], "Demo Title");
    assert!(result["markdown"].as_str().unwrap().contains("Alpha PDF"));
    server.await.unwrap();
    let _ = fs::remove_dir_all(&root);

    let paragraph = "A verified source paragraph with enough detail to retain. ".repeat(12);
    let html = format!(
        "<html><body><article><h1>Local fallback</h1><p>{paragraph}</p></article></body></html>"
    );
    let (endpoint, server, _) = serve(vec![("text/html", html.into_bytes())]).await;
    let root = super::data_root();
    let access = WebAccess::for_test_with_page_endpoint(
        root.clone(),
        "http://127.0.0.1:9/search",
        &endpoint,
    );
    let result = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://example.com/article","backend":"jina-hosted"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["reader"], "butler-lightweight");
    assert_eq!(result["method"], "readability");
    assert!(
        result["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning == "jina-hosted-reader-not-yet-enabled")
    );
    server.await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn auto_reader_keeps_lightweight_after_missing_lightpanda() {
    let challenge =
        "<html><body>enable javascript please".to_owned() + &"<script>void 0;</script>".repeat(10);
    let (endpoint, server, _) = serve(vec![("text/html", challenge.into_bytes())]).await;
    let root = super::data_root();
    let access = WebAccess::for_test_with_page_endpoint_and_lightpanda(
        root.clone(),
        "http://127.0.0.1:9/search",
        &endpoint,
        PathBuf::from("/missing/lightpanda"),
    );
    let result = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://example.com/app","backend":"auto"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["reader"], "butler-lightweight");
    assert!(
        result["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning == "lightpanda-unavailable-fell-back-to-lightweight")
    );
    server.await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn lightpanda_fallback_runs_and_reaps_configured_child() {
    use std::os::unix::fs::PermissionsExt;

    let challenge =
        "<html><body>enable javascript please".to_owned() + &"<script>void 0;</script>".repeat(10);
    let (endpoint, server, _) = serve(vec![("text/html", challenge.into_bytes())]).await;
    let root = super::data_root();
    let binary = root.join("fake-lightpanda");
    let rendered = format!(
        "<html><head><title>Rendered source</title></head><body><article><h1>Rendered source</h1><p>{}</p></article></body></html>",
        "Rendered text confirms the page content with enough useful detail. ".repeat(12),
    );
    fs::write(
        &binary,
        format!(
            "#!/bin/sh\nprintf '%s' '{}'\n",
            rendered.replace('\'', "'\\''")
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&binary).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&binary, permissions).unwrap();
    let access = WebAccess::for_test_with_page_endpoint_and_lightpanda(
        root.clone(),
        "http://127.0.0.1:9/search",
        &endpoint,
        binary,
    );
    let result = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://example.com/app","backend":"auto"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["reader"], "lightpanda");
    assert_eq!(result["title"], "Rendered source");
    assert!(
        result["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning == "lightpanda-rendered-fallback-used")
    );
    server.await.unwrap();
    let _ = fs::remove_dir_all(root);
}
