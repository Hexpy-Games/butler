use std::{fs, path::PathBuf, time::Duration};

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use super::WebAccess;

mod readers;
mod search_providers;

fn data_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!("native-web-access-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

async fn respond_once(content_type: &str, body: &str) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let content_type = content_type.to_owned();
    let body = body.to_owned();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 2_048];
        let _ = stream.read(&mut request).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (format!("http://{address}/search"), server)
}

#[tokio::test]
async fn search_result_projects_public_evidence_and_direct_planner_limit() {
    let html = r#"<div class="result"><a class="result__a" href="https://example.com/report">Example report</a><div class="result__snippet">A public source snippet.</div></div>"#;
    let (endpoint, server) = respond_once("text/html", html).await;
    let root = data_root();
    let access = WebAccess::for_test(root.clone(), &endpoint);
    let session = access.session_for_turn(String::new());
    let result = session
        .web_search(
            &json!({"query":"example report"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["provider"], "duckduckgo-html");
    assert_eq!(result["search_plan"]["mode"], "direct");
    assert_eq!(result["search_plan"]["planner_used"], false);
    assert_eq!(result["results"][0]["url"], "https://example.com/report");
    assert_eq!(
        result["public_web_evidence_items"][0]["producer"],
        "web_search"
    );
    assert_eq!(
        result["evidence_capability_receipts"][0]["capability"],
        "source_candidate"
    );
    assert_eq!(result["evidence_receipts"][0]["receiptType"], "coverage");
    server.await.unwrap();
    drop(session);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn page_read_returns_turn_evidence_and_drops_data_spool_with_session() {
    let paragraph = "Public source text includes verifiable details and context. ".repeat(18);
    let html = format!(
        "<html><head><title>Study</title></head><body><article><h1>Study results</h1><p>{paragraph}</p></article></body></html>"
    );
    let (endpoint, server) = respond_once("text/html", &html).await;
    let root = data_root();
    let access = WebAccess::for_test(root.clone(), &endpoint);
    let session = access.session_for_turn(String::new());
    let args = json!({"url":endpoint,"max_chars":2000,"max_chunks":2});
    let result = session
        .web_read(&args, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["title"], "Study");
    assert_eq!(
        result["evidence_capability_receipts"][0]["capability"],
        "source_verified"
    );
    assert!(
        result["evidence_capability_receipts"][0]["receipt_id"]
            .as_str()
            .unwrap()
            .starts_with("ecr-")
    );
    assert_eq!(
        result["evidence_capability_receipts"][0]["satisfies"][0],
        "source_verified"
    );
    assert_eq!(
        result["public_web_evidence_items"][0]["content_kind"],
        "page_chunk"
    );
    assert_eq!(result["evidence_receipts"][0]["receiptType"], "source");
    assert_eq!(
        result["evidence_receipts"][0]["covers"][0],
        "source_verified"
    );
    assert_eq!(
        result["evidence_receipts"][0]["satisfies"][0],
        "source_verified"
    );
    assert!(result["chunks"][0]["text"].as_str().unwrap().len() <= 320);
    assert_eq!(result["cache_hit"], false);
    let cached = session
        .web_read(&args, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(cached["cache_hit"], true);
    assert_eq!(cached["duplicate_observation"], true);
    server.await.unwrap();
    let spool_dir = root.join("tmp/web-access-spool");
    assert_eq!(fs::read_dir(&spool_dir).unwrap().count(), 1);
    drop(session);
    assert_eq!(fs::read_dir(&spool_dir).unwrap().count(), 0);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn cancellation_interrupts_body_stream_and_cleans_partial_spool() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, received) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 2_048];
        let _ = stream.read(&mut request).await;
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await
            .unwrap();
        let body = "<html><body>still streaming</body></html>";
        stream
            .write_all(format!("{:x}\r\n{body}\r\n", body.len()).as_bytes())
            .await
            .unwrap();
        let _ = sent.send(());
        tokio::time::sleep(Duration::from_secs(3)).await;
    });
    let root = data_root();
    let access = WebAccess::for_test(root.clone(), &format!("http://{address}/search"));
    let session = access.session_for_turn(String::new());
    let cancellation = CancellationToken::new();
    let task_token = cancellation.clone();
    let task = tokio::spawn(async move {
        session
            .web_search(&json!({"query":"cancel test"}), &task_token)
            .await
    });
    received.await.unwrap();
    let spool_dir = root.join("tmp/web-access-spool");
    let mut partial_spool_written = false;
    for _ in 0..100 {
        partial_spool_written = fs::read_dir(&spool_dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| entry.metadata().is_ok_and(|metadata| metadata.len() > 0));
        if partial_spool_written {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        partial_spool_written,
        "response chunk was not spooled before cancellation"
    );
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().code, "cancelled");
    server.abort();
    let remaining_spools = fs::read_dir(&spool_dir).ok().into_iter().flatten().count();
    assert_eq!(remaining_spools, 0);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn configured_provider_without_credential_uses_duckduckgo_fallback() {
    let html = r#"<div class="result"><a class="result__a" href="https://example.com/fallback">Fallback source</a></div>"#;
    let (endpoint, server) = respond_once("text/html", html).await;
    let root = data_root();
    fs::write(
        root.join("butler.config.json"),
        r#"{"webSearch":{"provider":"brave"}}"#,
    )
    .unwrap();
    let access = WebAccess::for_test(root.clone(), &endpoint);
    let result = access
        .session_for_turn(String::new())
        .web_search(&json!({"query":"example query"}), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result["provider"], "duckduckgo-html");
    assert_eq!(result["results"][0]["url"], "https://example.com/fallback");
    server.await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn disabled_provider_is_projected_and_not_called() {
    let root = data_root();
    fs::write(
        root.join("butler.config.json"),
        r#"{"webSearch":{"provider":"disabled"}}"#,
    )
    .unwrap();
    let access = WebAccess::for_test(root.clone(), "http://127.0.0.1:9/search");
    let session = access.session_for_turn(String::new());
    assert_eq!(
        session
            .configured_disabled_reason("web_search")
            .map(|item| item.0),
        Some("Public web search is disabled by configuration.")
    );
    let error = session
        .web_search(&json!({"query":"example query"}), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, "web_search_provider_disabled");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn disabled_reader_does_not_fetch_and_credentials_are_rejected() {
    let root = data_root();
    let access = WebAccess::for_test(root.clone(), "http://127.0.0.1:9/search");
    let result = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://example.com","backend":"disabled"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["warnings"][0], "page-reader-disabled");
    assert_eq!(result["reader"], "disabled");
    let credential_url = access
        .session_for_turn(String::new())
        .web_read(
            &json!({"url":"https://user:secret@example.com/private"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(credential_url.code, "invalid_arguments");
    assert!(!credential_url.message.contains("secret"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn evidence_projection_matches_source_utf16_truncation_and_deduplicates_limitations() {
    let input = "😀".repeat(12);
    let (bounded, truncated) = super::evidence::bounded_text(&input, 20);
    assert!(truncated);
    assert_eq!(bounded, "😀😀\n...[truncated]");
    assert_eq!(bounded.encode_utf16().count(), 19);

    let item = super::evidence::public_item(
        "web_read",
        "https://example.com/source",
        "2026-01-01T00:00:00.000Z",
        None,
        "page_excerpt",
        "source text",
        &["same limitation".into(), "same limitation".into()],
    );
    assert_eq!(item["limitations"], json!(["same limitation"]));
}
