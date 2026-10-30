//! Retry safety and route/resource distinction at the client's public boundary.
use super::transport::Peer;
use super::*;
use axum::{
    Router,
    body::Body,
    response::Response,
    routing::{get, post},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn failed_create_is_sent_once_even_if_the_server_created_the_chat() -> Result<(), TestError> {
    butler_e2e::gate!();
    let created = Arc::new(AtomicUsize::new(0));
    let peer = Peer::new(Router::new().route(
        "/sessions",
        post({
            let created = created.clone();
            move || {
                created.fetch_add(1, Ordering::SeqCst);
                async { Response::builder().status(500).body(Body::empty()).unwrap() }
            }
        }),
    ))
    .await?;
    let error = peer.client().await?.create_session(None).await.unwrap_err();
    assert!(matches!(error, butler_shell_client::Error::Http(500)));
    assert_eq!(created.load(Ordering::SeqCst), 1, "no duplicate chat");
    Ok(())
}

#[tokio::test]
async fn missing_route_requires_update_and_missing_resource_is_gone() -> Result<(), TestError> {
    butler_e2e::gate!();
    for (code, expected) in [
        ("not_found", butler_shell_client::FailureKind::Incompatible),
        (
            "session_not_found",
            butler_shell_client::FailureKind::Missing,
        ),
    ] {
        let peer = Peer::new(Router::new().route(
            "/session-view",
            get(move || async move {
                Response::builder()
                    .status(404)
                    .body(Body::from(json!({"error":{"code":code}}).to_string()))
                    .unwrap()
            }),
        ))
        .await?;
        let error = peer
            .client()
            .await?
            .message_window("missing", None, 200)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), expected);
    }
    Ok(())
}

#[tokio::test]
async fn transient_live_and_replay_bursts_outlast_request_retry_budget() -> Result<(), TestError> {
    butler_e2e::gate!();
    let connections = Arc::new(AtomicUsize::new(0));
    let replays = Arc::new(AtomicUsize::new(0));
    let peer = Peer::new(Router::new()
        .route("/events/live", get({
            let count = connections.clone();
            move || {
                let attempt = count.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 4 { return Response::builder().status(503).body(Body::empty()).unwrap(); }
                    Response::builder().header("content-type", "text/event-stream")
                        .body(Body::from("data: {\"id\":1,\"type\":\"retained\"}\n\ndata: {\"id\":3,\"type\":\"retained\"}\n\n")).unwrap()
                }
            }
        }))
        .route("/events", get({
            let count = replays.clone();
            move || {
                let attempt = count.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 4 { return Response::builder().status(503).body(Body::empty()).unwrap(); }
                    Response::new(Body::from(json!({"data":{"events":[{"id":3,"type":"retained"}],"next_cursor":3}}).to_string()))
                }
            }
        }))).await?;
    let mut stream = peer.client().await?.live_events(0);
    let began = std::time::Instant::now();
    let observed = tokio::time::timeout(Duration::from_secs(15), async {
        let first = stream.next().await.unwrap().unwrap();
        let later = stream.next().await.unwrap().unwrap();
        [first.cursor, later.cursor]
    })
    .await?;
    assert_eq!(observed, [Some(1), Some(3)]);
    assert_eq!(connections.load(Ordering::SeqCst), 5);
    assert_eq!(replays.load(Ordering::SeqCst), 5);
    eprintln!(
        "SHELL live/replay 503 bursts recovered in {:?}",
        began.elapsed()
    );
    Ok(())
}
