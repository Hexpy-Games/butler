//! Real updater bytes, indeterminate downloads and lifecycle facts via gateway SSE.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, events::LiveEvents, gateway::Gateway, scenario::Setup};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
#[path = "update_progress/scale.rs"]
mod scale;

const BYTES: usize = 131_072;
const WAIT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn update_progress_bytes_unknown_length_failure_cancel_and_retry() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("UPDATE-PROGRESS")?.env("BUTLER_APP_VERSION", "0.0.1");
    let bytes = vec![42u8; BYTES];
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let feed = feed(bytes);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, feed).await;
    });
    let manifest = setup.sandbox.root.join("manifest.json");
    let write = |name: &str, hash: &str| {
        std::fs::write(&manifest, json!({"artifacts":[{
        "component":"app", "version":"99.0.0", "channel":"stable",
        "artifact_url":format!("{base}/{name}.zip"), "sha256":hash,
        "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
        "rollback_policy":"not-managed-by-butler"
    }]}).to_string())
    };
    write("known", &digest)?;
    let s = setup
        .env("BUTLER_APP_UPDATE_MANIFEST", manifest.to_string_lossy())
        .start()
        .await?;
    let seed_cursor = scale::seed(&s.sandbox.data).await?;
    for (name, hash, terminal) in [
        ("known", digest.as_str(), "ready"),
        ("unknown", digest.as_str(), "ready"),
        (
            "known",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "failed",
        ),
    ] {
        write(name, hash)?;
        download(&s.gw, name, terminal, seed_cursor).await?;
    }
    write("slow", &digest)?;
    cancel(&s.gw, seed_cursor).await?;
    write("known", &digest)?;
    download(&s.gw, "known", "ready", seed_cursor).await?;
    let before = s.gw.events_since(seed_cursor).await?;
    let modified = std::fs::metadata(s.sandbox.data.join("updates/status.json"))?.modified()?;
    for _ in 0..3 {
        assert_eq!(s.gw.get("/updates").await?.status, 200);
    }
    assert_eq!(
        s.gw.events_since(seed_cursor).await?,
        before,
        "idle reads append no events"
    );
    assert_eq!(
        std::fs::metadata(s.sandbox.data.join("updates/status.json"))?.modified()?,
        modified
    );
    assert!(
        std::fs::read_dir(s.sandbox.data.join("updates/artifacts"))?.all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("tmp")),
        "cancel removes partial package"
    );
    eprintln!(
        "UPDATE-PROGRESS: final bytes={BYTES}, idle event/file writes=0, cancellation and retry passed"
    );
    task.abort();
    s.finish().await
}
fn feed(bytes: Vec<u8>) -> axum::Router {
    let known = bytes.clone();
    axum::Router::new()
        .route(
            "/known.zip",
            axum::routing::get(move || {
                let bytes = known.clone();
                async move { bytes }
            }),
        )
        .route(
            "/{name}",
            axum::routing::get(
                move |axum::extract::Path(name): axum::extract::Path<String>| {
                    let chunks: Vec<_> = bytes.chunks(32_768).map(Vec::from).collect();
                    async move {
                        axum::body::Body::from_stream(futures_util::stream::unfold(
                            (chunks.into_iter(), name == "slow.zip"),
                            |(mut chunks, slow)| async move {
                                let bytes = chunks.next()?;
                                if slow {
                                    tokio::time::sleep(Duration::from_millis(300)).await;
                                }
                                Some((Ok::<_, std::io::Error>(bytes), (chunks, slow)))
                            },
                        ))
                    }
                },
            ),
        )
}
async fn subscribe(gw: &Gateway, seed_cursor: u64) -> Result<LiveEvents, HarnessError> {
    let cursor = gw
        .events_since(seed_cursor)
        .await?
        .last()
        .and_then(|e| e["id"].as_u64())
        .unwrap_or(seed_cursor);
    LiveEvents::subscribe(gw, cursor).await
}
fn progresses(events: &LiveEvents) -> Vec<Value> {
    events
        .snapshot()
        .into_iter()
        .filter(|e| e["type"] == "updates.progress")
        .map(|e| e["payload"]["progress"].clone())
        .collect()
}
async fn wait(events: &LiveEvents, stage: &str) -> Result<(), HarnessError> {
    events
        .wait_for(WAIT, |e| {
            e["type"] == "updates.progress" && e["payload"]["progress"]["stage"] == stage
        })
        .await?;
    Ok(())
}
async fn download(
    gw: &Gateway,
    name: &str,
    terminal: &str,
    seed_cursor: u64,
) -> Result<(), HarnessError> {
    let events = subscribe(gw, seed_cursor).await?;
    let started = Instant::now();
    let applied = gw
        .post("/updates/apply", json!({"component":"app"}))
        .await?;
    assert_eq!(
        applied.status,
        if terminal == "failed" { 422 } else { 200 },
        "{}",
        applied.text
    );
    wait(&events, terminal).await?;
    let progress = progresses(&events);
    let stages: Vec<_> = progress
        .iter()
        .map(|p| p["stage"].as_str().unwrap())
        .collect();
    assert_eq!(stages.first(), Some(&"checking"));
    assert_eq!(&stages[stages.len() - 2..], &["verifying", terminal]);
    let downloads: Vec<_> = progress
        .iter()
        .filter(|p| p["stage"] == "downloading")
        .collect();
    assert_eq!(downloads.first().unwrap()["bytes_done"], 0);
    assert_eq!(downloads.last().unwrap()["bytes_done"], BYTES);
    for p in &downloads {
        assert_eq!(
            p["bytes_total"],
            if name == "known" {
                json!(BYTES)
            } else {
                Value::Null
            }
        );
    }
    assert!(
        downloads
            .windows(2)
            .all(|pair| pair[0]["bytes_done"].as_u64() <= pair[1]["bytes_done"].as_u64())
    );
    assert!(
        progress
            .windows(2)
            .all(|pair| pair[0]["revision"].as_u64() < pair[1]["revision"].as_u64())
    );
    let read_started = Instant::now();
    let status = gw.get("/updates").await?;
    assert_eq!(
        status.data()["progress"]["stage"],
        terminal,
        "navigation snapshot"
    );
    assert_eq!(
        status.data()["components"][0]["available_version"],
        "99.0.0"
    );
    butler_e2e::assert_wall_clock_budget!(
        read_started.elapsed(),
        Duration::from_millis(1000),
        "progress snapshot"
    );
    eprintln!(
        "UPDATE-PROGRESS {name}/{terminal}: {:?}, stages={stages:?}, final bytes={BYTES}",
        started.elapsed()
    );
    if terminal == "ready" {
        host_lifecycle(gw, &events, stages.len()).await?;
    }
    Ok(())
}
async fn host_lifecycle(
    gw: &Gateway,
    events: &LiveEvents,
    offset: usize,
) -> Result<(), HarnessError> {
    let phases = ["verifying", "ready", "applying", "restarting", "failed"];
    for stage in phases {
        let reply = gw.post("/updates/progress", json!({"stage":stage})).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert!(
            reply.data()["bytes_total"].is_null(),
            "no Squirrel activation byte telemetry"
        );
        assert_eq!(reply.data()["cancellable"], false);
    }
    wait(events, "failed").await?;
    let progress = progresses(events);
    let actual: Vec<_> = progress[offset..]
        .iter()
        .map(|p| p["stage"].as_str().unwrap())
        .collect();
    assert_eq!(actual, phases);
    assert_eq!(
        gw.post("/updates/progress", json!({"stage":"downloading"}))
            .await?
            .status,
        409,
        "host cannot invent downloads"
    );
    Ok(())
}
async fn cancel(gw: &Gateway, seed_cursor: u64) -> Result<(), HarnessError> {
    let events = subscribe(gw, seed_cursor).await?;
    let apply = tokio::spawn({
        let gw = gw.clone();
        async move { gw.post("/updates/apply", json!({"component":"app"})).await }
    });
    wait(&events, "downloading").await?;
    let progress = gw.get("/updates").await?;
    assert_eq!(progress.data()["progress"]["cancellable"], true);
    assert_eq!(
        gw.post("/updates/cancel", json!({})).await?.data()["cancelled"],
        true
    );
    let reply = apply.await.expect("apply task")?;
    assert_eq!(reply.error_code(), Some("update_cancelled"));
    wait(&events, "failed").await?;
    assert_eq!(
        progresses(&events).last().unwrap()["error_code"],
        "update_cancelled"
    );
    assert_eq!(
        gw.post("/updates/cancel", json!({})).await?.data()["cancelled"],
        false
    );
    Ok(())
}
