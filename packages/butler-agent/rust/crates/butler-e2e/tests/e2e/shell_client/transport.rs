//! Controlled HTTP peers exercise credential refresh and a silent SSE socket.
use super::*;
use axum::{
    Router, body::Body, extract::State, http::StatusCode, response::Response, routing::get,
};
use std::sync::{Arc, Mutex};

pub(super) struct Peer {
    setup: Setup,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Peer {
    pub(super) async fn new(router: Router) -> Result<Self, TestError> {
        let setup = Setup::new("SHELL-HTTP")?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let pid = std::process::id();
        std::fs::create_dir_all(setup.sandbox.data.join("state"))?;
        std::fs::write(
            setup
                .sandbox
                .data
                .join("state/butler-agent-native-service.json"),
            serde_json::to_vec(&json!({
                "schema":"butler.native-agent-service-instance.v1", "nonce":"peer", "pid":pid,
                "process_start":butler_platform::instance::process_start(pid)?.unwrap(),
                "executable":butler_platform::instance::process_executable(pid)?.unwrap(),
                "state":"ready", "app_enabled":true,
                "app_endpoint":format!("http://{}",listener.local_addr()?)
            }))?,
        )?;
        write_token(&setup.sandbox.data, "old")?;
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Ok(Self { setup, task })
    }
    pub(super) async fn client(&self) -> Result<ShellClient, TestError> {
        match ShellClient::attach(Some(self.setup.sandbox.data.clone())).await? {
            AttachState::Connected(client) => Ok(client),
            AttachState::NotRunning => panic!("peer instance not found"),
        }
    }
}
fn write_token(data: &std::path::Path, token: &str) -> Result<(), TestError> {
    std::fs::create_dir_all(data.join(butler_platform::data_paths::LOCAL_AUTH_DIR))?;
    std::fs::write(
        data.join(butler_platform::data_paths::LOCAL_AUTH),
        serde_json::to_vec(&json!({"token":token}))?,
    )?;
    Ok(())
}

#[derive(Clone, Default)]
struct Refresh {
    data: Arc<Mutex<Option<std::path::PathBuf>>>,
    observed: Arc<Mutex<Vec<u16>>>,
}
async fn credential(State(state): State<Refresh>, headers: axum::http::HeaderMap) -> Response {
    if headers.get("authorization").unwrap() == "Bearer old" {
        state.observed.lock().unwrap().push(401);
        if let Some(data) = state.data.lock().unwrap().as_ref() {
            write_token(data, "new").unwrap();
        }
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    assert_eq!(headers.get("authorization").unwrap(), "Bearer new");
    state.observed.lock().unwrap().push(200);
    Response::new(Body::from(
        json!({"data":{"items":[],"next_cursor":null,"event_cursor":0}}).to_string(),
    ))
}

#[tokio::test]
async fn refresh_observes_401_then_reads_new_token_then_succeeds() -> Result<(), TestError> {
    butler_e2e::gate!();
    let state = Refresh::default();
    let peer = Peer::new(
        Router::new()
            .route("/chats", get(credential))
            .with_state(state.clone()),
    )
    .await?;
    *state.data.lock().unwrap() = Some(peer.setup.sandbox.data.clone());
    let client = peer.client().await?;
    assert_eq!(
        client.list_chats(PageRequest::new(2, None)?).await?.items,
        [] as [serde_json::Value; 0]
    );
    assert_eq!(*state.observed.lock().unwrap(), [401, 200]);
    Ok(())
}

#[tokio::test]
async fn unchanged_bad_token_returns_auth_error_without_retry_loop() -> Result<(), TestError> {
    butler_e2e::gate!();
    let state = Refresh::default();
    let peer = Peer::new(
        Router::new()
            .route("/chats", get(credential))
            .with_state(state.clone()),
    )
    .await?;
    let client = peer.client().await?;
    let error = client
        .list_chats(PageRequest::new(2, None)?)
        .await
        .unwrap_err();
    assert!(matches!(error, butler_shell_client::Error::Authentication));
    assert_eq!(*state.observed.lock().unwrap(), [401]);
    Ok(())
}

async fn stalled(
    State(count): State<Arc<std::sync::atomic::AtomicUsize>>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    use std::sync::atomic::Ordering;
    let attempt = count.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        query.get("cursor").map(String::as_str),
        Some(if attempt == 0 { "0" } else { "1" })
    );
    let stream = futures_util::stream::once(async move {
        let event = if attempt == 0 { 1 } else { 2 };
        Ok::<_, std::io::Error>(format!(
            "data: {{\"id\":{event},\"type\":\"future.event\",\"payload\":{{}}}}\n\n"
        ))
    })
    .chain(futures_util::stream::pending());
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

#[tokio::test]
async fn silent_stream_reconnects_after_idle_timeout() -> Result<(), TestError> {
    butler_e2e::gate!();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let peer = Peer::new(
        Router::new()
            .route("/events/live", get(stalled))
            .with_state(count.clone()),
    )
    .await?;
    let client = peer.client().await?;
    let mut stream = client.live_events(0);
    assert_eq!(stream.next().await.unwrap()?.cursor, Some(1));
    let began = std::time::Instant::now();
    let next = tokio::time::timeout(Duration::from_secs(55), stream.next())
        .await?
        .unwrap()?;
    assert_eq!(next.cursor, Some(2));
    assert!(began.elapsed() >= Duration::from_secs(40));
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2);
    eprintln!("SHELL idle reconnect {:?}", began.elapsed());
    Ok(())
}

async fn jumped() -> Response {
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(
            "data: {\"id\":1,\"type\":\"retained\"}\n\ndata: {\"id\":3,\"type\":\"retained\"}\n\n",
        ))
        .unwrap()
}
async fn replay_hole() -> axum::Json<serde_json::Value> {
    axum::Json(json!({"data":{"events":[{"id":3,"type":"retained"}],"next_cursor":3}}))
}
#[tokio::test]
async fn live_jump_replays_hole_once_and_advances() -> Result<(), TestError> {
    butler_e2e::gate!();
    let peer = Peer::new(
        Router::new()
            .route("/events/live", get(jumped))
            .route("/events", get(replay_hole)),
    )
    .await?;
    let client = peer.client().await?;
    let mut stream = client.live_events(0);
    let ids = tokio::time::timeout(Duration::from_secs(5), async {
        let a = stream.next().await.unwrap().unwrap().cursor;
        let b = stream.next().await.unwrap().unwrap().cursor;
        [a, b]
    })
    .await?;
    assert_eq!(ids, [Some(1), Some(3)]);
    Ok(())
}

async fn transient(State(count): State<Arc<std::sync::atomic::AtomicUsize>>) -> Response {
    if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
        return Response::builder().status(503).body(Body::empty()).unwrap();
    }
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from("data: {\"id\":1,\"type\":\"future.event\"}\n\n"))
        .unwrap()
}

#[tokio::test]
async fn transient_failure_recovers_without_an_instance_rewrite() -> Result<(), TestError> {
    butler_e2e::gate!();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let peer = Peer::new(
        Router::new()
            .route("/events/live", get(transient))
            .with_state(count.clone()),
    )
    .await?;
    let record = peer
        .setup
        .sandbox
        .data
        .join("state/butler-agent-native-service.json");
    let before = std::fs::read(&record)?;
    let mut stream = peer.client().await?.live_events(0);
    let began = std::time::Instant::now();
    let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await?
        .unwrap()?;
    assert_eq!(event.cursor, Some(1));
    assert_eq!(event.raw["type"], "future.event");
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(std::fs::read(record)?, before);
    eprintln!("SHELL transient 503 recovery {:?}", began.elapsed());
    Ok(())
}

#[tokio::test]
async fn request_failures_are_bounded_and_leave_the_client_usable() -> Result<(), TestError> {
    butler_e2e::gate!();
    use butler_shell_client::{Error, FailureKind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    for (status, attempts, kind) in [
        (403, 1, FailureKind::Refused),
        (408, 1, FailureKind::Refused),
        (404, 1, FailureKind::Missing),
        (429, 3, FailureKind::Retryable),
        (503, 3, FailureKind::Retryable),
    ] {
        let count = Arc::new(AtomicUsize::new(0));
        let peer = Peer::new(Router::new().route(
            "/chats",
            get({
                let count = count.clone();
                move || {
                    let attempt = count.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if attempt < attempts {
                            Response::builder()
                                .status(status)
                                .body(Body::from(
                                    json!({"error":{"code":"session_not_found"}}).to_string(),
                                ))
                                .unwrap()
                        } else {
                            Response::new(Body::from(
                                json!({"data":{"items":[],"next_cursor":null,"event_cursor":17}})
                                    .to_string(),
                            ))
                        }
                    }
                }
            }),
        ))
        .await?;
        let client = peer.client().await?;
        let error = client
            .list_chats(PageRequest::new(2, None)?)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Http(code) if code == status));
        assert_eq!(error.kind(), kind);
        assert_eq!(count.load(Ordering::SeqCst), attempts);
        let page = client.list_chats(PageRequest::new(2, None)?).await?;
        assert_eq!(page.items, [] as [serde_json::Value; 0]);
        assert_eq!(page.event_cursor, 17);
        assert_eq!(count.load(Ordering::SeqCst), attempts + 1);
    }
    Ok(())
}
