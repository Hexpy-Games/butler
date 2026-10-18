//! Fresh-install equivalence and request-time launcher retention across recovery.
use super::*;
use std::{fs, fs::OpenOptions, io::Write};

#[tokio::test]
async fn active_legacy_schedule_never_returns_or_runs_after_reset() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("Q-02")?;
    cassette.exchanges.clear();
    let setup = setup("RESET-LEGACY-SCHEDULE")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_APP_NOW", "2026-03-07T00:00:00.000Z");
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let root = s.sandbox.data.clone();
    let db = butler_platform::sqlite::open(root.join("app-server/butler-client.sqlite"))?;
    db.execute(
        "DELETE FROM app_settings WHERE key='schedule_json_import_v1'",
        [],
    )?;
    drop(db);
    let legacy = root.join("automations");
    fs::create_dir_all(&legacy)?;
    fs::write(
        legacy.join("old.json"),
        json!({
            "id":"old","title":"Old schedule","prompt":"Old private prompt",
            "session_id":"butler/main","status":"active",
            "schedule":{"type":"once","run_at":"2030-01-01T00:00:00.000Z"},
            "next_run_at":"2030-01-01T00:00:00.000Z","last_run_at":null,
            "run_count":0,"created_at":"2025-01-01T00:00:00.000Z",
            "updated_at":"2025-01-01T00:00:00.000Z"
        })
        .to_string(),
    )?;
    s.gw = s.agent.start_again().await?;
    let old = s.gw.get("/automations/old").await?;
    assert_eq!(old.status, 200, "{}", old.text);
    assert_eq!(old.data()["automation"]["state"], "enabled");
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2031-01-01T00:00:00.000Z");
    s.gw = s.agent.start_again().await?;
    let schedules = s.gw.get("/automations").await?;
    assert_eq!(
        schedules.data()["automations"],
        json!([]),
        "{}",
        schedules.text
    );
    cleaned(&s.sandbox.data).await;
    assert!(!legacy.exists());
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let runs: i64 = db.query_row("SELECT COUNT(*) FROM app_automation_runs", [], |r| r.get(0))?;
    assert_eq!(runs, 0);
    assert_eq!(s.provider()?.requests(), Vec::<Value>::new());
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn all_remaining_private_stores_are_removed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-REMAINING-STORES")?.start().await?;
    let root = s.sandbox.data.clone();
    let stores = [
        "context/compactions/old.jsonl",
        "tasks/old/task.json",
        "transcript-projection-spool/old.json",
        "log-exports/old/summary.txt",
        "memory/old/private.md",
    ];
    for name in stores {
        fs::create_dir_all(root.join(name).parent().unwrap())?;
        fs::write(root.join(name), b"old private data")?;
    }
    super::allowlist::reset_and_restart(&mut s).await?;
    for name in stores {
        assert!(!root.join(name).exists(), "retained {name}");
    }
    s.finish().await
}

#[tokio::test]
async fn generic_custom_root_is_never_claimed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = unowned_setup("RESET-GENERIC-ROOT")?;
    for name in ["bin", "config", "logs"] {
        fs::create_dir_all(setup.sandbox.data.join(name))?;
        fs::write(setup.sandbox.data.join(name).join("keep"), name)?;
    }
    let s = setup.start().await?;
    let root = &s.sandbox.data;
    assert!(!root.join("state/data-root-owner.json").exists());
    let before = generation(&s).await?;
    let config = fs::read(root.join("butler.config.json"))?;
    let reply = request(&s, &nonce(&s).await?).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("full_reset_unsafe_root"));
    assert_eq!(generation(&s).await?, before);
    assert_eq!(fs::read(root.join("butler.config.json"))?, config);
    assert!(!root.join("state/full-reset.json").exists());
    for name in ["bin", "config", "logs"] {
        assert_eq!(fs::read(root.join(name).join("keep"))?, name.as_bytes());
    }
    s.finish().await
}

#[tokio::test]
async fn recovery_keeps_only_the_launcher_logs_recorded_by_the_request() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = setup("RESET-FROZEN-LOGS")?
        .env("BUTLER_APP_AGENT_LOG", "logs/request.log")
        .start()
        .await?;
    let root = s.sandbox.data.clone();
    fs::create_dir_all(root.join("logs"))?;
    fs::write(root.join("logs/request.log"), b"request private bytes")?;
    fs::write(root.join("logs/recovery.log"), b"other private bytes")?;
    let mut handle = OpenOptions::new()
        .append(true)
        .open(root.join("logs/request.log"))?;
    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.kill9()?;
    let journal: Value = serde_json::from_slice(&fs::read(root.join("state/full-reset.json"))?)?;
    assert!(
        journal["kept_logs"]
            .as_array()
            .unwrap()
            .contains(&json!("logs/request.log"))
    );
    assert!(
        !journal["kept_logs"]
            .as_array()
            .unwrap()
            .contains(&json!("logs/recovery.log"))
    );
    s.agent
        .launch
        .set_env("BUTLER_APP_AGENT_LOG", "logs/recovery.log");
    s.gw = s.agent.start_again().await?;
    cleaned(&root).await;
    assert!(!root.join("logs/recovery.log").exists());
    assert_eq!(fs::metadata(root.join("logs/request.log"))?.len(), 0);
    handle.write_all(b"new output")?;
    assert_eq!(fs::read(root.join("logs/request.log"))?, b"new output");
    s.finish().await
}

#[tokio::test]
async fn command_caches_are_removed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-COMMAND-CACHES")?.start().await?;
    let root = s.sandbox.data.clone();
    for name in ["cache/tools", "cache/project-write"] {
        fs::create_dir_all(root.join(name))?;
        fs::write(root.join(name).join("private"), b"command state")?;
    }
    super::allowlist::reset_and_restart(&mut s).await?;
    for name in ["cache/tools", "cache/project-write"] {
        assert!(!root.join(name).exists(), "retained {name}");
    }
    s.finish().await
}

#[tokio::test]
async fn structured_log_stores_are_removed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("RESET-STRUCTURED-LOGS")?.start().await?;
    let root = s.sandbox.data.clone();
    for source in ["agent", "app"] {
        let path = root
            .join("logs")
            .join(source)
            .join("main/old-private.sentinel");
        fs::create_dir_all(path.parent().unwrap())?;
        fs::write(path, b"private log bytes")?;
    }
    super::allowlist::reset_and_restart(&mut s).await?;
    for source in ["agent", "app"] {
        assert!(
            !root
                .join("logs")
                .join(source)
                .join("main/old-private.sentinel")
                .exists(),
            "retained structured logs: {source}"
        );
    }
    s.finish().await
}
