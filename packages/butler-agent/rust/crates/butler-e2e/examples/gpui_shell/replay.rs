//! Drive the real shell adapter through a 200-event peer and count its reads.
use super::Shots;
use axum::{Router, body::Body, response::Response, routing::get};
use serde_json::json;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

pub(super) async fn run(binary: &Path, dir: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    let setup = butler_e2e::e2e::scenario::Setup::new("GPUI-REPLAY")?;
    let reads = Arc::new(AtomicUsize::new(0));
    let authority = Arc::new(AtomicUsize::new(0));
    let controls_status = Arc::new(AtomicUsize::new(0));
    let row = json!({"id":"replay","title":"Replay","created_at":"2026-10-29T00:00:00Z","updated_at":"2026-10-29T00:00:01Z","pinned":false,"archived":false});
    let app = Router::new()
        .route("/sessions", get({
            let reads = reads.clone(); let row = row.clone();
            move || { let row = row.clone(); reads.fetch_add(1, Ordering::SeqCst); async move {
                axum::Json(json!({"data":{"items":[row],"next_cursor":null,"event_cursor":0}}))
            }}
        }))
        .route("/sessions/replay/controls", get({
            let status = controls_status.clone();
            move || { let failed = status.load(Ordering::SeqCst) != 0; async move {
                if failed { return Err(axum::http::StatusCode::FORBIDDEN); }
                Ok(axum::Json(json!({"data":{"controls":{"access_mode":"future_permission","model":"stub","reasoning_effort":"none"}}})))
            }}
        }))
        .route("/session-view", get(|| async {
            axum::Json(json!({"data":{"messages":[],"cursors":{"events":200},"message_window":{}}}))
        }))
        .route("/authority-requests", get({
            let count = authority.clone();
            move || { count.fetch_add(1, Ordering::SeqCst); async { axum::Json(json!({"data":{"requests":[]}})) }}
        }))
        .route("/events/live", get(events));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let state = setup.sandbox.data.join("state");
    tokio::fs::create_dir_all(&state).await?;
    let pid = std::process::id();
    let record = json!({"schema":"butler.native-agent-service-instance.v1","nonce":"replay","pid":pid,
        "process_start":butler_platform::instance::process_start(pid)?.ok_or_else(|| anyhow::anyhow!("process start"))?,
        "executable":butler_platform::instance::process_executable(pid)?.ok_or_else(|| anyhow::anyhow!("executable"))?,
        "state":"ready","app_enabled":true,"app_endpoint":endpoint});
    tokio::fs::write(
        state.join("butler-agent-native-service.json"),
        serde_json::to_vec(&record)?,
    )
    .await?;
    let auth = setup
        .sandbox
        .data
        .join(butler_platform::data_paths::LOCAL_AUTH);
    tokio::fs::create_dir_all(
        auth.parent()
            .ok_or_else(|| anyhow::anyhow!("auth parent"))?,
    )
    .await?;
    tokio::fs::write(auth, br#"{"token":"stub"}"#).await?;
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let result = drive(
        binary,
        &setup.sandbox.data,
        dir,
        &reads,
        &authority,
        &controls_status,
    )
    .await;
    task.abort();
    result
}
async fn drive(
    binary: &Path,
    data: &Path,
    dir: &Path,
    reads: &AtomicUsize,
    authority: &AtomicUsize,
    controls_status: &AtomicUsize,
) -> anyhow::Result<()> {
    let mut h = Shots::start(binary, data, dir, false).await?;
    let result = async {
        h.command("connected").await?;
        h.command("cursor 200").await?;
        // Allow both the debounced read and any trailing read to complete.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        h.command("shot replay-200").await?;
        let refreshes = reads.load(Ordering::SeqCst) - 1;
        let authority = authority.load(Ordering::SeqCst);
        anyhow::ensure!(
            (1..=2).contains(&refreshes),
            "{refreshes} refreshes for 200 events"
        );
        anyhow::ensure!(
            (1..=2).contains(&authority),
            "{authority} authority reads for 200 events"
        );
        tokio::fs::write(
            dir.join("counts.json"),
            serde_json::to_vec_pretty(
                &json!({"events":200,"refreshes":refreshes,"authority_reads":authority}),
            )?,
        )
        .await?;
        h.command("controls loaded").await?;
        h.command("new").await?;
        h.command("shot unknown-permission").await?;
        controls_status.store(1, Ordering::SeqCst);
        h.command("open replay").await?;
        h.command("controls unavailable").await?;
        h.command("new").await?;
        h.command("shot controls-unavailable").await?;
        Ok(())
    }
    .await;
    let stopped = h.finish().await;
    result?;
    stopped
}
async fn events() -> Response {
    use std::fmt::Write as _;
    let mut text = String::new();
    for id in 1..=200 {
        let event = json!({"id":id,"type":"turn.state_changed","payload":{"chat_id":"replay","turn":{"id":"turn","state":"delivered"}}});
        let _ = writeln!(text, "data: {event}\n");
    }
    use futures_util::StreamExt as _;
    let stream = futures_util::stream::once(async { Ok::<_, std::io::Error>(text) })
        .chain(futures_util::stream::pending());
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        "content-type",
        axum::http::HeaderValue::from_static("text/event-stream"),
    );
    response
}
