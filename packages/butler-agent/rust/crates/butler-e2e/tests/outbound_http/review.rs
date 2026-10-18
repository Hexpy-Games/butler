use super::*;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn content_length_survives_success_and_error_prefix() -> Result<(), Box<dyn std::error::Error>>
{
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed())?;
    for (status, text) in [
        (200, ""),
        (200, "known download total"),
        (429, "rate limited"),
    ] {
        let (url, task) = server(status, text.into()).await;
        let response = http::external(Purpose::new("download"))
            .build()?
            .get(url)
            .send()
            .await?;
        assert_eq!(response.content_length(), Some(text.len() as u64));
        assert_eq!(response.text().await?, text);
        task.abort();
    }
    Ok(())
}

#[tokio::test]
async fn refused_stream_replays_and_logs_each_attempt() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed())?;
    logger().clear()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/replay", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut connection = h2::server::handshake(socket).await.unwrap();
        let mut count = 0;
        while let Some(request) = connection.accept().await {
            let (_, mut respond) = request.unwrap();
            count += 1;
            if count == 1 {
                respond.send_reset(h2::Reason::REFUSED_STREAM);
            } else {
                respond
                    .send_response(::http::Response::new(()), true)
                    .unwrap();
            }
        }
        count
    });
    let client = http::external(Purpose::new("replay"))
        .http2_prior_knowledge()
        .build()?;
    let response = client.get(url).send().await?;
    assert_eq!(response.status(), 200);
    assert!(response.bytes().await?.is_empty());
    let rows = rows();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|row| row.attrs["retry"] == 0));
    assert!(rows.iter().any(|row| row.attrs["retry"] == 1));
    let retries = logger().query(&Query {
        category: Some("http.client".into()),
        ..Query::default()
    })?;
    assert_eq!(
        retries
            .rows
            .iter()
            .filter(|row| row.event == "http.retry")
            .count(),
        1
    );
    task.abort();
    Ok(())
}

#[tokio::test]
async fn broken_error_body_preserves_status_headers_and_read_error()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed())?;
    logger().clear()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/broken", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket.write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 100\r\nRetry-After: 42\r\n\r\npartial").await.unwrap();
    });
    let response = http::external(Purpose::new("probe"))
        .build()?
        .get(url)
        .send()
        .await?;
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["retry-after"], "42");
    assert!(response.bytes().await.is_err());
    task.await?;
    assert!(rows()[0].error.as_ref().unwrap()["message"].is_string());
    Ok(())
}

#[tokio::test]
async fn routine_rejections_are_debug_and_placeholders_stay_literal()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::default())?;
    logger().clear()?;
    let (url, task) = server(401, "unauthorized".into()).await;
    http::external(Purpose::new("poll"))
        .build()?
        .get(url)
        .bearer_auth("ollama")
        .phase(Phase::new("poll", 1).routine())
        .send()
        .await?
        .bytes()
        .await?;
    assert!(rows().is_empty());
    assert_eq!(
        butler_log::redact_log_line("ollama EMPTY lm-studio"),
        "ollama EMPTY lm-studio"
    );
    task.abort();
    Ok(())
}

#[tokio::test]
async fn full_200mb_binary_download_has_bounded_rss_and_complete_digest()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::full())?;
    logger().clear()?;
    const LENGTH: usize = 200 * 1024 * 1024;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/archive", listener.local_addr()?);
    let app = axum::Router::new().fallback(|| async {
        let chunk = bytes::Bytes::from(vec![73; 65536]);
        let chunks = futures_util::stream::iter(
            (0..3200).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
        );
        axum::http::Response::builder()
            .header("content-type", "application/octet-stream")
            .header("content-length", LENGTH)
            .body(axum::body::Body::from_stream(chunks))
            .unwrap()
    });
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut response = http::external(Purpose::new("download"))
        .build()?
        .get(url)
        .send()
        .await?;
    assert_eq!(response.content_length(), Some(LENGTH as u64));
    let baseline = rss().await?;
    let mut peak = baseline;
    let mut length = 0;
    let mut hash = Sha256::new();
    let mut next_sample = 0;
    while let Some(chunk) = response.chunk().await? {
        length += chunk.len();
        assert!(chunk.iter().all(|b| *b == 73));
        hash.update(&chunk);
        if length >= next_sample {
            peak = peak.max(rss().await?);
            next_sample = length + 8 * 1024 * 1024;
        }
    }
    drop(response);
    assert_eq!(length, LENGTH);
    let row = rows().remove(0);
    let body = row.content.as_ref().unwrap();
    assert_eq!(row.attrs["response_bytes"], LENGTH);
    assert_eq!(row.attrs["response_complete"], true);
    assert_eq!(body["response"]["length"], LENGTH);
    assert_eq!(body["response"]["sha256"], format!("{:x}", hash.finalize()));
    assert!(body["response"].get("base64").is_none());
    let growth = peak.saturating_sub(baseline);
    eprintln!("HTTP full 200 MiB: baseline_rss={baseline} peak_rss={peak} growth={growth}");
    assert!(
        growth < 64 * 1024 * 1024,
        "bounded capture RSS growth: {growth}"
    );
    logger().configure(Config::detailed())?;
    task.abort();
    Ok(())
}
async fn rss() -> Result<u64, Box<dyn std::error::Error>> {
    Ok(tokio::task::spawn_blocking(|| {
        butler_platform::process_control::sample_usage(std::process::id())
    })
    .await??
    .unwrap()
    .resident_bytes)
}

#[tokio::test]
async fn credential_rotation_replaces_source_without_scrubbing_placeholders()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    let previous = "previous-credential-123456789";
    let current = "current-credential-1234567890";
    butler_log::register_secret_for("rotation", previous);
    butler_log::register_secret_for("rotation", current);
    butler_log::register_secret_for("placeholder", "EMPTY");
    assert_eq!(butler_log::redact_log_line(previous), previous);
    assert_eq!(butler_log::redact_log_line(current), "[REDACTED]");
    assert_eq!(butler_log::redact_log_line("EMPTY"), "EMPTY");
    Ok(())
}

#[tokio::test]
async fn ordinary_resource_paths_are_not_registered_as_credentials()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed())?;
    logger().clear()?;
    let segment = "public-resource-abcdefghijklmno";
    let (url, task) = server(200, "complete resource".into()).await;
    let mut url = url::Url::parse(&url)?;
    url.set_path(&format!("/{segment}"));
    let response = http::external(Purpose::new("fetch"))
        .build()?
        .get(url)
        .send()
        .await?;
    assert_eq!(response.text().await?, "complete resource");
    assert!(rows()[0].attrs["path"].as_str().unwrap().contains(segment));
    assert_eq!(butler_log::redact_log_line(segment), segment);
    task.abort();
    Ok(())
}
