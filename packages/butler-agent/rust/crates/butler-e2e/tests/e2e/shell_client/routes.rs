//! Desktop route uploads, tracing and the independent log stream.
use super::{transport::Peer, *};
use axum::{
    Router,
    body::Body,
    http::HeaderMap,
    response::Response,
    routing::{get, post},
};
use butler_shell_client::{Error, Upload};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn message_file_upload_round_trips_bytes() -> Result<(), TestError> {
    butler_e2e::gate!();
    let s = start("SHELL-UPLOAD", 0, Access::FullAccess).await?;
    let client = attach(&s).await?;
    let session = client.create_session(Some("upload")).await?;
    let mut bytes = vec![0; 4096];
    bytes[..12].copy_from_slice(b"\r\n--\r\n--x\r\n-");
    let file = Upload {
        file_name: "image.png".into(),
        content_type: "image/png".into(),
        bytes,
    };
    let uploaded = client
        .upload_message_file(session["session"]["id"].as_str().unwrap(), &file)
        .await?;
    let downloaded = client
        .download_message_file(uploaded["file"]["file_id"].as_str().unwrap())
        .await?;
    assert_eq!(downloaded.bytes, file.bytes);
    assert_eq!(downloaded.content_type.as_deref(), Some("image/png"));
    Ok(s.finish().await?)
}

#[tokio::test]
async fn multipart_refuses_header_injection() -> Result<(), TestError> {
    butler_e2e::gate!();
    let requests = Arc::new(AtomicUsize::new(0));
    let observed = requests.clone();
    let peer = Peer::new(Router::new().route(
        "/message-files",
        post(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            async { axum::Json(json!({"data":{}})) }
        }),
    ))
    .await?;
    let file = Upload {
        file_name: "bad\r\nheader.png".into(),
        content_type: "image/png".into(),
        bytes: vec![1],
    };
    assert!(matches!(
        peer.client()
            .await?
            .upload_message_file("general", &file)
            .await,
        Err(Error::Protocol)
    ));
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn traceparent_is_sent_only_by_the_traced_clone() -> Result<(), TestError> {
    butler_e2e::gate!();
    let headers = Arc::new(Mutex::new(Vec::new()));
    let observed = headers.clone();
    let peer = Peer::new(Router::new().route(
        "/messages",
        post(move |received: HeaderMap| {
            observed.lock().unwrap().push(
                received
                    .get("traceparent")
                    .map(|v| v.to_str().unwrap().to_owned()),
            );
            async { axum::Json(json!({"data":{}})) }
        }),
    ))
    .await?;
    let client = peer.client().await?;
    let trace = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    let traced = client.with_trace(trace)?;
    traced
        .send_message(&json!({"chat_id":"general", "text":"traced"}))
        .await?;
    client
        .send_message(&json!({"chat_id":"general", "text":"original"}))
        .await?;
    assert_eq!(*headers.lock().unwrap(), [Some(trace.to_owned()), None]);
    assert!(matches!(client.with_trace("invalid"), Err(Error::Protocol)));
    Ok(())
}

#[tokio::test]
async fn live_logs_skips_heartbeats_and_reconnects() -> Result<(), TestError> {
    butler_e2e::gate!();
    let connections = Arc::new(AtomicUsize::new(0));
    let observed = connections.clone();
    let peer = Peer::new(Router::new().route(
        "/logs/live",
        get(move || {
            let connection = observed.fetch_add(1, Ordering::SeqCst);
            async move {
                let data = if connection == 0 {
                    "event: heartbeat\ndata: {}\n\nevent: log\ndata: {\"message\":\"first\"}\n\n"
                } else {
                    "event: log\ndata: {\"message\":\"second\"}\n\n"
                };
                let stream =
                    futures_util::stream::once(async move { Ok::<_, std::io::Error>(data) });
                let body = if connection == 0 {
                    Body::from_stream(stream)
                } else {
                    Body::from_stream(stream.chain(futures_util::stream::pending()))
                };
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(body)
                    .unwrap()
            }
        }),
    ))
    .await?;
    let mut logs = peer.client().await?.live_logs();
    let records = tokio::time::timeout(Duration::from_secs(5), async {
        let first = logs.next().await.unwrap().unwrap();
        let second = logs.next().await.unwrap().unwrap();
        [first, second]
    })
    .await?;
    assert_eq!(
        records,
        [json!({"message":"first"}), json!({"message":"second"})]
    );
    assert_eq!(connections.load(Ordering::SeqCst), 2);
    assert!(
        tokio::time::timeout(Duration::from_millis(150), logs.next())
            .await
            .is_err()
    );
    Ok(())
}
