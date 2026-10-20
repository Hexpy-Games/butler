//! Full reset is a local-admin, journaled transition across process replacement.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    gateway::Reply,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};
mod allowlist;
mod interruption;
mod review;
mod round2;
mod round5;
mod seed;

fn setup(id: &str) -> Result<Setup, HarnessError> {
    let setup = unowned_setup(id)?;
    // Reset scenarios model an installed Butler root, including its real store.
    // Settings-only fixtures intentionally no longer establish custom ownership.
    butler_turn::btcc::bootstrap_fresh_storage(
        &setup
            .sandbox
            .data
            .join(butler_platform::data_paths::BTCC_DB),
        "full-reset-fixture",
        env!("CARGO_PKG_VERSION"),
        "2026-10-18T00:00:00Z",
    )
    .map_err(|e| HarnessError(e.to_string()))?;
    Ok(setup)
}
fn unowned_setup(id: &str) -> Result<Setup, HarnessError> {
    Ok(Setup::new(id)?
        .data_folder_token()
        .env("BUTLER_APP_VERSION", "1.0.0"))
}
fn admin(s: &Scenario) -> AdminClient {
    AdminClient::new(
        s.gw.clone(),
        s.agent.launch.admin_credential().expect("admin credential"),
    )
}
async fn nonce(s: &Scenario) -> Result<String, HarnessError> {
    let reply = admin(s).send(Method::GET, "/data/reset", None, &[]).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    chrono::DateTime::parse_from_rfc3339(reply.data()["expires_at"].as_str().unwrap())
        .expect("RFC3339 expiry");
    Ok(reply.data()["nonce"].as_str().unwrap().into())
}
async fn request(s: &Scenario, nonce: &str) -> Result<Reply, HarnessError> {
    admin(s)
        .send(
            Method::POST,
            "/data/reset",
            Some(json!({
                "operation_id":"reset.operation-1", "nonce":nonce, "confirmation":"reset-all-data"
            })),
            &[],
        )
        .await
}
async fn generation(s: &Scenario) -> Result<Value, HarnessError> {
    let settings = s.gw.get("/settings").await?;
    let value = settings.data()["data_generation"].clone();
    assert_ne!(value.as_str().unwrap(), "");
    let info = s.gw.get("/app-info").await?;
    assert_eq!(info.status, 200, "{}", info.text);
    assert_eq!(info.data()["data_generation"], value);
    Ok(value)
}
async fn cleaned(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while root.join("state/full-reset.json").exists() {
        assert!(Instant::now() < deadline, "cleanup did not finish");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!std::fs::read_dir(root).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".reset-trash-")
    }));
}

#[tokio::test]
async fn reset_01_replacement_clears_data_preserves_keeps_and_rotates_auth()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-01")?
        .env("BUTLER_SECRET_STORE", "file")
        .start()
        .await?;
    seed::seed(&s).await?;
    let live = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    let before = generation(&s).await?;
    let old = s.gw.clone();
    let root = s.sandbox.data.clone();
    for name in [
        "project-ledger/sentinel",
        "cache/models/sentinel",
        "cache/browser/sentinel",
    ] {
        std::fs::create_dir_all(root.join(name).parent().unwrap())?;
        std::fs::write(root.join(name), b"keep")?;
    }
    let outside = s.sandbox.workspace.join("outside.txt");
    std::fs::write(&outside, b"outside")?;
    butler_platform::secure_fs::symlink(&outside, &root.join("outside-link"))?;
    std::fs::write(root.join("discard-me"), b"private")?;
    std::fs::create_dir_all(root.join("outputs"))?;
    std::fs::write(root.join("outputs/reset-proof"), b"private")?;
    let accepted = request(&s, &nonce(&s).await?).await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    assert_eq!(
        accepted.data(),
        &json!({"operation_id":"reset.operation-1", "restart":"app"})
    );
    let event = live
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "data.reset_started"
        })
        .await?;
    assert_eq!(event["payload"]["operation_id"], "reset.operation-1");
    drop(live);
    let refused =
        s.gw.post("/messages", json!({"chat_id":"general","text":"blocked"}))
            .await?;
    assert_eq!(refused.status, 503, "{}", refused.text);
    assert_eq!(refused.error_code(), Some("service_resetting"));
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_ne!(generation(&s).await?, before);
    assert_eq!(old.get("/settings").await?.status, 401);
    let settings = s.gw.get("/settings").await?;
    assert!(
        settings.data()["onboarding"]["completed_at"].is_null(),
        "{}",
        settings.text
    );
    assert_eq!(std::fs::read(root.join("discard-me"))?, b"private");
    assert!(!root.join("outputs/reset-proof").exists());
    assert!(
        std::fs::symlink_metadata(root.join("outside-link"))?
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read(&outside)?, b"outside");
    for name in [
        "project-ledger/sentinel",
        "cache/models/sentinel",
        "cache/browser/sentinel",
    ] {
        assert_eq!(std::fs::read(root.join(name))?, b"keep");
    }
    cleaned(&root).await;
    seed::assert_empty(&s).await?;
    eprintln!(
        "{}",
        s.agent
            .logs()
            .lines()
            .filter(|l| l.contains("[full-reset] applied"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    s.finish().await
}

#[tokio::test]
async fn reset_04_invalid_requests_consume_nonce_without_disk_changes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = setup("RESET-04")?.start().await?;
    let before = generation(&s).await?;
    for body in [
        json!({}),
        json!({"operation_id":"bad/id","confirmation":"reset-all-data"}),
        json!({"operation_id":"ok","confirmation":"wrong"}),
        json!({"operation_id":"ok","confirmation":"reset-all-data","extra":true}),
    ] {
        let n = nonce(&s).await?;
        let mut body = body;
        body["nonce"] = n.clone().into();
        let reply = admin(&s)
            .send(Method::POST, "/data/reset", Some(body), &[])
            .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert_eq!(reply.error_code(), Some("full_reset_confirmation_invalid"));
        assert_eq!(request(&s, &n).await?.status, 400, "nonce was not consumed");
    }
    assert_eq!(request(&s, "unknown").await?.status, 400);
    let app = admin(&s);
    for body in ["{".to_owned(), "{}".to_owned(), "x".repeat(4097)] {
        let reply =
            s.gw.send_with(
                Method::POST,
                "/data/reset",
                Some(body),
                Some(&s.gw.token),
                &[(butler_e2e::e2e::agent::ADMIN_HEADER, &app.admin)],
            )
            .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert_eq!(reply.error_code(), Some("full_reset_confirmation_invalid"));
    }
    review::generic_admission(&s).await?;
    for method in [Method::GET, Method::POST] {
        let reply =
            s.gw.send_with(
                method,
                "/data/reset",
                Some("{}".into()),
                Some(&s.gw.token),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 403);
        assert_eq!(reply.error_code(), Some("admin_credential_required"));
    }
    let n = nonce(&s).await?;
    s.agent.launch.admin_credential().expect("admin");
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    assert_eq!(generation(&s).await?, before);
    assert_ne!(n, "");
    s.finish().await
}

#[tokio::test]
async fn reset_06_external_store_refused_without_journal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-06")?;
    let outside = setup.sandbox.workspace.join("external.sqlite");
    let s = setup
        .env("BUTLER_APP_SERVER_DB", outside.display().to_string())
        .start()
        .await?;
    let before = generation(&s).await?;
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("full_reset_external_store"));
    assert!(!s.sandbox.data.join("state/full-reset.json").exists());
    assert_eq!(generation(&s).await?, before);
    s.finish().await
}

#[tokio::test]
async fn fresh_custom_root_is_owned_and_resettable_in_first_session() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup =
        unowned_setup("RESET-FRESH-CUSTOM")?.fixture(butler_e2e::e2e::scenario::Fixture::Empty);
    assert!(std::fs::read_dir(&setup.sandbox.data)?.next().is_none());
    let s = setup.start().await?;
    assert!(s.sandbox.data.join("state/data-root-owner.json").is_file());
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    s.finish().await
}
