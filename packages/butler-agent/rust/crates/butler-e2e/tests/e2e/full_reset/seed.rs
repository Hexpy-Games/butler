//! Small API/DB fixtures plus retained files exercise complete removal.
use super::*;
use butler_platform::sqlite;
pub(super) async fn seed(s: &Scenario) -> Result<(), HarnessError> {
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Discarded chat"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let id = chat.data()["session"]["id"].as_str().unwrap();
    let schedule = s.gw.post("/automations", json!({"title":"Discarded schedule","prompt_body":"Do nothing","target_session_id":id,"interval_seconds":3600})).await?;
    assert_eq!(schedule.status, 201, "{}", schedule.text);
    let key =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"openai","api_key":"sk-reset-fixture-key"}),
        )
        .await?;
    assert_eq!(key.status, 201, "{}", key.text);
    let done = s.gw.patch("/settings", json!({"onboarding":{"consent_version":1,"accepted_at":"2026-10-18T01:00:00Z","completed_at":"2026-10-18T01:01:00Z"}})).await?;
    assert_eq!(done.status, 200, "{}", done.text);
    assert!(!done.data()["onboarding"]["completed_at"].is_null());
    let rules = s.sandbox.data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    std::fs::write(
        rules.join("reset-rule.md"),
        "Keep this explicit rule only before reset.",
    )?;
    std::fs::write(rules.join("INDEX.md"), "- [reset-rule](reset-rule.md)\n")?;
    std::fs::create_dir_all(s.sandbox.data.join("cognition/profile"))?;
    let db = sqlite::open(s.sandbox.data.join("cognition/profile/profile.sqlite"))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS stable_profile_entries(id TEXT PRIMARY KEY,category TEXT NOT NULL,payload_json TEXT NOT NULL,confidence TEXT NOT NULL,source_type TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")?;
    db.execute("INSERT INTO stable_profile_entries(id,category,payload_json,confidence,source_type,created_at,updated_at) VALUES('reset-profile','communication','{}','high','explicit','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')", [])?;
    drop(db);
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO paired_devices(id,secret_hash,name,ip,created_at,last_seen_at) VALUES('reset-device',zeroblob(32),'Discarded device','127.0.0.1',1,1)", [])?;
    let project = s.sandbox.workspace.join("registered-project");
    std::fs::create_dir_all(project.join(".butler"))?;
    std::fs::write(
        project.join(".butler/hot-cache.md"),
        b"discard project hot cache",
    )?;
    std::fs::write(project.join(".butler/keep.md"), b"keep project metadata")?;
    std::fs::write(project.join("source.txt"), b"keep user project")?;
    db.execute("INSERT INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,created_at,updated_at) VALUES('reset-project','Registered project','active',?1,'project','project','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')", [project.display().to_string()])?;
    drop(db);
    for (name, bytes) in [
        ("transcripts/retained-fixture", 8_192),
        ("metrics/retained-fixture", 4_096),
        ("reset-fixture/retained-fixture", 16_384),
        ("agent-runtime/retained-fixture", 16_384),
    ] {
        let path = s.sandbox.data.join(name);
        std::fs::create_dir_all(path.parent().unwrap())?;
        let file = std::fs::File::create(&path)?;
        file.set_len(bytes)?;
        assert_eq!(file.metadata()?.len(), bytes);
    }
    for name in [
        "attachments/reset-attachment",
        "app/browser/reset-profile",
        "favicons/reset-icon",
        "app-server/message-files/reset-attachment",
        "outputs/reset-output",
        "logs/reset-log",
        "state/browser/reset-profile",
        "cache/favicons/reset-icon",
        "downloads/reset-download",
    ] {
        let path = s.sandbox.data.join(name);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, b"discard")?;
    }
    Ok(())
}
pub(super) async fn assert_empty(s: &Scenario) -> Result<(), HarnessError> {
    for (table, db) in [
        ("paired_devices", "app-server/butler-client.sqlite"),
        ("app_automations", "app-server/butler-client.sqlite"),
        ("stable_profile_entries", "cognition/profile/profile.sqlite"),
    ] {
        let path = s.sandbox.data.join(db);
        if !path.exists() {
            continue;
        } // Fresh profile storage is opened lazily.
        let db = sqlite::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let count: i64 =
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        assert_eq!(count, 0, "{table}");
    }
    let credentials = s.gw.get("/credentials").await?;
    assert_eq!(
        credentials.data()["credentials"],
        json!([]),
        "{}",
        credentials.text
    );
    let inventory = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(inventory.status, 200, "{}", inventory.text);
    for kind in inventory.data()["kinds"].as_array().unwrap() {
        assert_eq!(kind["item_count"], 0, "{kind}");
    }
    for name in [
        "app-server/message-files/reset-attachment",
        "outputs/reset-output",
        "logs/reset-log",
        "state/browser/reset-profile",
        "cache/favicons/reset-icon",
        "downloads/reset-download",
        "transcripts/retained-fixture",
        "metrics/retained-fixture",
        "agent-runtime/retained-fixture",
    ] {
        assert!(!s.sandbox.data.join(name).exists(), "retained {name}");
    }
    for name in [
        "attachments/reset-attachment",
        "app/browser/reset-profile",
        "favicons/reset-icon",
    ] {
        assert_eq!(std::fs::read(s.sandbox.data.join(name))?, b"discard");
    }
    assert_eq!(
        std::fs::metadata(s.sandbox.data.join("reset-fixture/retained-fixture"))?.len(),
        16_384
    );
    let project = s.sandbox.workspace.join("registered-project");
    assert!(!project.join(".butler/hot-cache.md").exists());
    assert_eq!(
        std::fs::read(project.join(".butler/keep.md"))?,
        b"keep project metadata"
    );
    assert_eq!(
        std::fs::read(project.join("source.txt"))?,
        b"keep user project"
    );
    Ok(())
}
