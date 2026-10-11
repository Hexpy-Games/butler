//! USE-07 — `GET /updates` answers from the last saved status and never
//! waits for the network: a slow manifest server is only reached by a
//! background check, `POST /updates/check` forces one, and a manifest the App
//! cannot use is a calm status, not an error.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::Setup;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// How long the manifest server takes to answer.
const DELAY: Duration = Duration::from_secs(3);
/// An answer that did not wait for the network.
const INSTANT: Duration = Duration::from_millis(1_000);

/// A manifest server that answers after [`DELAY`] and counts its requests.
struct Manifest {
    url: String,
    hits: Arc<AtomicU64>,
    incompatible: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Manifest {
    async fn start() -> Result<Self, HarnessError> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/app-update-manifest.json", listener.local_addr()?);
        let hits = Arc::new(AtomicU64::new(0));
        let incompatible = Arc::new(AtomicBool::new(false));
        let (seen, broken) = (hits.clone(), incompatible.clone());
        let app = axum::Router::new().fallback(move || {
            let (seen, broken) = (seen.clone(), broken.clone());
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(DELAY).await;
                let mut artifact = json!({
                    "component": "app", "version": "99.0.0", "channel": "stable",
                    "staging_policy": "butler-data-updates",
                    "activation_policy": "user-installs-app-package",
                    "rollback_policy": "not-managed-by-butler",
                });
                if broken.load(Ordering::SeqCst) {
                    artifact["update_policy"] = json!("not-a-policy-the-app-knows");
                }
                axum::Json(json!({"artifacts": [artifact]}))
            }
        });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            url,
            hits,
            incompatible,
            task,
        })
    }

    fn hits(&self) -> u64 {
        self.hits.load(Ordering::SeqCst)
    }

    async fn wait_for_hit(&self) -> Result<(), HarnessError> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.hits() == 0 {
            assert!(Instant::now() < deadline, "manifest was not requested");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    }
}

impl Drop for Manifest {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn get_updates(gw: &Gateway) -> Result<(Duration, Value), HarnessError> {
    let started = Instant::now();
    let reply = gw.get("/updates").await?;
    let took = started.elapsed();
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok((took, reply.data()["components"][0].clone()))
}

/// Polls `GET /updates` (each poll instant) until `done` holds of the component.
async fn until(gw: &Gateway, done: impl Fn(&Value) -> bool) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (took, component) = get_updates(gw).await?;
        butler_e2e::assert_wall_clock_budget!(took, INSTANT, "GET /updates took");
        if done(&component) {
            return Ok(component);
        }
        assert!(
            Instant::now() < deadline,
            "the status did not change: {component}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn use_07_updates_read_never_waits_for_the_network() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let manifest = Manifest::start().await?;
    let setup = Setup::new("USE-07")?
        .env("BUTLER_UPDATE_MANIFEST", manifest.url.clone())
        .env("BUTLER_APP_VERSION", "0.0.1");
    // A saved status from a week ago: served as it is, refreshed behind it.
    let old = "2026-09-01T00:00:00.000Z";
    let saved = json!({
        "generated_at": old,
        "components": [{
            "component": "app", "current_version": "0.0.1", "available_version": "0.0.5",
            "update_available": true, "channel": "stable", "checked_at": old,
            "check_state": "ok", "check_error": null,
        }],
        "storage_label": "updates", "manifest_source": "saved", "raw_text_included": false,
    });
    let updates = setup.sandbox.data.join("updates");
    fs::create_dir_all(&updates)?;
    fs::write(updates.join("status.json"), saved.to_string())?;
    let s = setup.start().await?;

    let (took, component) = get_updates(&s.gw).await?;
    butler_e2e::assert_wall_clock_budget!(took, INSTANT, "GET /updates took");
    eprintln!("USE-07 GET /updates: {took:?} (manifest delay {DELAY:?})");
    assert_eq!(component["available_version"], "0.0.5", "{component}");
    // The stale status started one background check, and only one.
    manifest.wait_for_hit().await?;
    let (again, _) = get_updates(&s.gw).await?;
    butler_e2e::assert_wall_clock_budget!(again, INSTANT, "updates: again");
    assert_eq!(manifest.hits(), 1, "a stale status starts one check");

    let component = until(&s.gw, |component| {
        component["available_version"] == "99.0.0"
    })
    .await?;
    assert_eq!(component["update_available"], true, "{component}");

    // Fresh now: reads do not touch the network.
    let hits = manifest.hits();
    for _ in 0..3 {
        let (took, _) = get_updates(&s.gw).await?;
        butler_e2e::assert_wall_clock_budget!(took, INSTANT, "updates: took");
    }
    assert_eq!(manifest.hits(), hits, "a fresh status is not refetched");

    // POST /updates/check forces the network.
    let started = Instant::now();
    let forced =
        s.gw.post("/updates/check", json!({"component": "app"}))
            .await?;
    assert_eq!(forced.status, 200, "{}", forced.text);
    let forced_took = started.elapsed();
    eprintln!("USE-07 POST /updates/check: {forced_took:?}");
    // Minimum injected delay proves that forced refresh actually hit the network.
    assert!(forced_took >= DELAY.checked_sub(Duration::from_millis(500)).unwrap());
    assert_eq!(manifest.hits(), hits + 1);

    // A manifest the App cannot use is a status, and reads stay instant.
    manifest.incompatible.store(true, Ordering::SeqCst);
    let unusable =
        s.gw.post("/updates/check", json!({"component": "app"}))
            .await?;
    assert_eq!(unusable.status, 200, "{}", unusable.text);
    let component = &unusable.data()["components"][0];
    assert_eq!(component["check_state"], "unavailable", "{component}");
    assert_eq!(component["check_error"], "update_manifest_incompatible");
    let (took, read) = get_updates(&s.gw).await?;
    butler_e2e::assert_wall_clock_budget!(took, INSTANT, "updates: took");
    assert_eq!(read["check_state"], "unavailable", "{read}");
    s.finish().await
}
