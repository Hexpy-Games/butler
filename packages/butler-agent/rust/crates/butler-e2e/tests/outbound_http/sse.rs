use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn sse_standard_skips_metadata_and_category_override_reads_long_terminal()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::default())?;
    let chunk = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n";
    let count = 100_000;
    let started = Instant::now();
    let observed = http::fixtures::observe_sse_chunks(chunk, count)?;
    let elapsed = started.elapsed();
    assert_eq!(observed["chunks"], count);
    assert_eq!(observed["bytes"], chunk.len() * count);
    assert!(observed["finish_reason"].is_null());
    eprintln!(
        "SSE standard chunks={count} bytes={} ns_per_chunk={:.3}",
        chunk.len() * count,
        elapsed.as_nanos() as f64 / count as f64
    );
    let terminal = format!(
        "data: {{\"response\":{{\"output\":[{}]}},\"type\":\"response.completed\"}}\n\n",
        serde_json::to_string(&"x".repeat(1_000_000))?
    );
    assert!(http::fixtures::observe_sse_chunks(terminal.as_bytes(), 1)?["finish_reason"].is_null());
    let mut config = Config::default();
    config
        .category_levels
        .insert("http.client".into(), "DEBUG".into());
    logger().configure(config)?;
    let observed = http::fixtures::observe_sse_chunks(terminal.as_bytes(), 1)?;
    assert_eq!(observed["finish_reason"], "completed");
    assert_eq!(observed["bytes"], terminal.len());
    for (data, reason) in [
        (json!({"choices":[{"finish_reason":"stop"}]}), "stop"),
        (json!({"candidates":[{"finishReason":"STOP"}]}), "STOP"),
        (json!({"delta":{"stop_reason":"end_turn"}}), "end_turn"),
    ] {
        let line = format!("data: {data}\n\n");
        assert_eq!(
            http::fixtures::observe_sse_chunks(line.as_bytes(), 1)?["finish_reason"],
            reason
        );
    }
    Ok(())
}

#[tokio::test]
async fn sse_receive_phase_excludes_request_wait_and_preserves_fragmented_terminal()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().configure(Config::detailed())?;
    logger().clear()?;
    let terminal = format!(
        "data: {}\n\n",
        json!({"response":{"output":"x".repeat(20_000)}, "type":"response.completed"})
    );
    let expected = terminal.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = axum::Router::new().fallback(move || {
        let terminal = terminal.clone();
        async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let fragments = terminal
                .as_bytes()
                .chunks(997)
                .map(bytes::Bytes::copy_from_slice)
                .collect::<Vec<_>>();
            let stream =
                futures_util::stream::unfold(fragments.into_iter(), |mut fragments| async {
                    let fragment = fragments.next()?;
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    Some((Ok::<_, std::io::Error>(fragment), fragments))
                });
            axum::http::Response::builder()
                .header("content-type", "text/event-stream")
                .body(axum::body::Body::from_stream(stream))
                .unwrap()
        }
    });
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let result = http::external(Purpose::new("stream"))
        .build()?
        .get(url)
        .phase(Phase::default().ids(Some("0123456789abcdef0123456789abcdef"), None, None))
        .send()
        .await?
        .text()
        .await;
    task.abort();
    assert_eq!(result?, expected);
    let row = rows().pop().unwrap();
    assert_eq!(row.attrs["finish_reason"], "completed");
    assert_eq!(row.attrs["response_bytes"], expected.len());
    assert_eq!(row.attrs["response_complete"], true);
    let trace = logger().trace("0123456789abcdef0123456789abcdef")?;
    let receive = trace
        .spans
        .iter()
        .find(|s| s.name == "stream.receive")
        .unwrap();
    assert_eq!(receive.parent_span_id, row.span_id);
    assert!(receive.start_offset_ms >= 90.0);
    assert!(row.duration_ms.unwrap() - receive.duration_ms.unwrap() >= 90.0);
    assert!(receive.duration_ms.unwrap() >= 20.0);
    Ok(())
}
