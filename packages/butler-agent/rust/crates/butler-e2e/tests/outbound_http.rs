//! Stub-tier coverage of the shared outbound HTTP boundary.
#![allow(clippy::disallowed_methods, reason = "test crate HTTP drivers")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_log::{
    Config, Logger, Query,
    http::{self, Phase, Purpose},
};
use serde_json::json;
use std::sync::OnceLock;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn logger() -> &'static Logger {
    static LOG: OnceLock<Logger> = OnceLock::new();
    LOG.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("http-logs-{}", uuid::Uuid::new_v4()));
        let log = Logger::open(&root, Config::detailed()).unwrap();
        butler_log::install(log.clone()).unwrap();
        log
    })
}
fn rows() -> Vec<butler_log::Record> {
    ["http.client", "provider"]
        .into_iter()
        .flat_map(|category| {
            logger()
                .query(&Query {
                    category: Some(category.into()),
                    ..Query::default()
                })
                .unwrap()
                .rows
        })
        .filter(|row| row.event == "http.request")
        .collect()
}
async fn server(status: u16, body: String) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/probe?token=seeded-fake-key&X-Amz-Signature=signature-value",
        listener.local_addr().unwrap()
    );
    let app = axum::Router::new().fallback(move |headers: axum::http::HeaderMap| {
        let body = body.clone();
        async move {
            assert!(!headers.contains_key("traceparent"));
            (axum::http::StatusCode::from_u16(status).unwrap(), body)
        }
    });
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn provider_request_logged_with_turn() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed()).unwrap();
    logger().clear().unwrap();
    butler_log::register_secret("seeded-fake-key");
    let (url, task) = server(200, "{}".into()).await;
    let client = http::external(Purpose::provider("local", "chat"))
        .build()
        .unwrap();
    let phase = Phase::new("turn", 0).ids(Some("trace"), Some("turn"), Some("chat"));
    client
        .post(&url)
        .bearer_auth("seeded-fake-key")
        .header("anthropic-ratelimit-unified-5h-reset", "600")
        .header("x-unrecognized-debug", "name-only")
        .json(&json!({"input":"hello"}))
        .phase(phase)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let rows = rows();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.category, "provider.local");
    assert_eq!(row.turn_id.as_deref(), Some("turn"));
    assert_eq!(row.trace_id.as_deref(), Some("trace"));
    assert_eq!(row.chat_id.as_deref(), Some("chat"));
    assert_eq!(row.attrs["method"], "POST");
    assert_eq!(row.attrs["status"], 200);
    assert_eq!(
        row.attrs["request_headers"]["anthropic-ratelimit-unified-5h-reset"],
        "600"
    );
    assert_eq!(row.attrs["request_headers"]["authorization"], "[REDACTED]");
    assert!(row.attrs["request_headers"]["x-unrecognized-debug"].is_null());
    for key in [
        "host",
        "path",
        "start",
        "first_byte_ms",
        "total_ms",
        "request_bytes",
        "response_bytes",
    ] {
        assert!(!row.attrs[key].is_null(), "{key}");
    }
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("seeded-fake-key")
    );
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("signature-value")
    );
    task.abort();
    Ok(())
}

#[tokio::test]
async fn background_model_calls_logged() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed()).unwrap();
    logger().clear().unwrap();
    let (url, task) = server(200, "{}".into()).await;
    for purpose in ["title", "memory_extraction"] {
        http::external(Purpose::provider("local", purpose))
            .build()
            .unwrap()
            .post(&url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
    }
    let rows = rows();
    assert_eq!(rows.len(), 2);
    for purpose in ["title", "memory_extraction"] {
        assert!(rows.iter().any(|r| r.attrs["purpose"] == purpose));
    }
    task.abort();
    Ok(())
}

#[tokio::test]
async fn bypass_sites_logged() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed()).unwrap();
    logger().clear().unwrap();
    let server = butler_e2e::e2e::fake_servers::FakeServer::provider_models()
        .await
        .unwrap();
    http::external(Purpose::new("provider_models"))
        .build()
        .unwrap()
        .get(format!("{}/v1/models", server.base_url))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(server.seen().len(), 1);
    assert_eq!(rows().len(), 1);
    Ok(())
}

#[tokio::test]
async fn error_body_detailed_and_full_bodies() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed()).unwrap();
    logger().clear().unwrap();
    let (url, task) = server(429, "rate limited".into()).await;
    http::external(Purpose::new("probe"))
        .build()
        .unwrap()
        .get(&url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let row = rows().remove(0);
    assert_eq!(row.level, "ERROR");
    assert_eq!(row.error.unwrap()["body"], "rate limited");
    assert!(row.content.is_none());
    assert!(row.body_ref.is_none());
    task.abort();
    logger().configure(Config::full()).unwrap();
    logger().clear().unwrap();
    let text = "full body ".repeat(2000);
    let (url, task) = server(200, text.clone()).await;
    http::external(Purpose::new("probe"))
        .build()
        .unwrap()
        .post(&url)
        .body("request text")
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let row = rows().remove(0);
    let body: serde_json::Value =
        serde_json::from_slice(&logger().body(row.body_ref.as_deref().unwrap()).unwrap()).unwrap();
    assert_eq!(body["request"], "request text");
    assert_eq!(body["response"], text);
    logger().configure(Config::detailed()).unwrap();
    task.abort();
    Ok(())
}

#[tokio::test]
async fn quota_poll_debug_no_idle_writes() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::default()).unwrap();
    logger().clear().unwrap();
    let (url, task) = server(200, "{}".into()).await;
    http::external(Purpose::new("quota"))
        .build()
        .unwrap()
        .get(&url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(rows().is_empty());
    task.abort();
    Ok(())
}

#[tokio::test]
async fn traceparent_never_sent_externally() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let (url, task) = server(200, "{}".into()).await;
    http::external(Purpose::new("probe"))
        .build()
        .unwrap()
        .get(&url)
        .header(
            "traceparent",
            "00-11111111111111111111111111111111-1111111111111111-01",
        )
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    task.abort();
    Ok(())
}

#[tokio::test]
async fn full_body_larger_than_segment_is_retrievable() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::full()).unwrap();
    logger().clear().unwrap();
    let text = "complete body\n".repeat(1_500_000);
    let expected = text.len();
    let (url, task) = server(200, text.clone()).await;
    let response = http::external(Purpose::new("download"))
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(response.len(), expected);
    assert_eq!(response.as_ref(), text.as_bytes());
    let row = rows().remove(0);
    assert_eq!(row.attrs["response_bytes"], expected);
    let body: serde_json::Value =
        serde_json::from_slice(&logger().body(row.body_ref.as_deref().unwrap()).unwrap()).unwrap();
    assert_eq!(
        body["response"].as_str().unwrap().as_bytes(),
        response.as_ref()
    );
    logger().configure(Config::detailed()).unwrap();
    task.abort();
    Ok(())
}

#[tokio::test]
async fn redirect_hops_preserve_url_and_logging() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed()).unwrap();
    logger().clear().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let destination = format!("{base}/end");
    let location = destination.clone();
    let app = axum::Router::new()
        .route(
            "/start",
            axum::routing::get(move || {
                let location = location.clone();
                async move { axum::response::Redirect::temporary(&location) }
            }),
        )
        .route("/end", axum::routing::get(|| async { "complete response" }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let response = http::external(Purpose::new("redirect"))
        .build()?
        .get(format!("{base}/start"))
        .send()
        .await?;
    assert_eq!(response.url().as_str(), destination);
    assert_eq!(response.text().await?, "complete response");
    let rows = rows();
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .any(|r| r.attrs["path"] == "/start" && r.attrs["status"] == 307)
    );
    assert!(
        rows.iter()
            .any(|r| r.attrs["path"] == "/end" && r.attrs["status"] == 200)
    );
    task.abort();
    Ok(())
}

#[tokio::test]
async fn web_page_fetch_is_logged_once_with_complete_response()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed())?;
    logger().clear()?;
    let root = std::env::temp_dir().join(format!("http-page-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root)?;
    std::fs::write(root.join(".env"), "BUTLER_WEB_READER_BACKEND=lightweight\n")?;
    let paragraph = "A complete source paragraph with independently verified details. ".repeat(30);
    let html =
        format!("<html><body><article><h1>Source</h1><p>{paragraph}</p></article></body></html>");
    let expected = html.len();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/article", listener.local_addr()?);
    let app = axum::Router::new().route(
        "/article",
        axum::routing::get(move || {
            let html = html.clone();
            async move { axum::response::Html(html) }
        }),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let access = butler_runtime::web_access::testing::access(root.clone(), &endpoint);
    let result = access
        .read_cli(&endpoint, &tokio_util::sync::CancellationToken::new())
        .await?;
    assert!(
        result
            .to_string()
            .contains("independently verified details")
    );
    let rows = rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].attrs["purpose"], "web_fetch");
    assert_eq!(rows[0].attrs["path"], "/article");
    assert_eq!(rows[0].attrs["status"], 200);
    assert_eq!(rows[0].attrs["response_bytes"], expected);
    assert_eq!(rows[0].attrs["response_complete"], true);
    assert!(result.to_string().contains(&endpoint));
    task.abort();
    std::fs::remove_dir_all(root)?;
    Ok(())
}
