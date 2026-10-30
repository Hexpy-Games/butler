//! A committed final transcript must outlive process staging cleanup.
use super::*;
use butler_platform::data_paths::{MESSAGE_HANDOFFS, READER_STAGING};
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[tokio::test]
async fn handoff_survives_kill_before_attachment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    restart(true).await
}

#[tokio::test]
async fn handoff_survives_stop_before_attachment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    restart(false).await
}

async fn restart(crash: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-HANDOFF")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let release = setup.sandbox.root.join("attach-release");
    let setup = setup
        .env("BUTLER_E2E_HOLD_POINT", "message_attachment")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_str().unwrap());
    *script.prompt.lock().unwrap() = "Deliver the file.".into();
    *script.steps.lock().unwrap() = [deliver("report.md", "Report"), done()].into();
    std::fs::write(setup.sandbox.data.join("report.md"), "Durable delivery")?;
    let mut s = setup.start().await?;
    let accepted = s.gw.say("general", "Deliver the file.").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    wait_for(|| release.with_extension("held").exists()).await;
    let data = &s.sandbox.data;
    assert_empty(&data.join(READER_STAGING))?;
    let copies = copies(data)?;
    assert_eq!(copies.len(), 1);
    assert_eq!(std::fs::read_to_string(&copies[0])?, "Durable delivery");
    // No fallback to the mutable project source can satisfy this check.
    std::fs::write(data.join("report.md"), "Changed after delivery")?;
    if crash {
        s.agent.kill9()?;
    } else {
        let stopped = s.agent.cli(&["stop", "--json"])?;
        assert_eq!(stopped.code, Some(0), "{}", stopped.stderr);
        assert!(s.agent.reap().unwrap().success());
    }
    assert_eq!(std::fs::read_to_string(&copies[0])?, "Durable delivery");
    std::fs::write(&release, "release")?;
    s.gw = s.agent.start_again().await?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    let message = last(&s).await?;
    let attachments = message["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1, "{message}");
    assert_eq!(
        s.gw.get(attachments[0]["url"].as_str().unwrap())
            .await?
            .text,
        "Durable delivery"
    );
    wait_for(|| copies.iter().all(|path| !path.exists())).await;
    assert_empty(&s.sandbox.data.join(READER_STAGING))?;
    eprintln!("handoff restart crash={crash}: 1/1 attachment intact; reader-staging empty");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn materialize_missing_handoff_preserves_other_attachments() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-MISSING-HANDOFF")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let release = setup.sandbox.root.join("attach-release");
    let setup = setup
        .env("BUTLER_E2E_HOLD_POINT", "message_attachment")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_str().unwrap());
    *script.prompt.lock().unwrap() = "Deliver the file.".into();
    *script.steps.lock().unwrap() = [call("deliver_files", json!({"files":[{"path":"report.md","title":"Report"},{"path":"kept.md","title":"Kept"}]})), done()].into();
    std::fs::write(setup.sandbox.data.join("kept.md"), "Still attached")?;
    std::fs::write(setup.sandbox.data.join("report.md"), "Available original")?;
    let mut s = setup.start().await?;
    let accepted = s.gw.say("general", "Deliver the file.").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    wait_for(|| release.with_extension("held").exists()).await;
    let staged = copies(&s.sandbox.data)?;
    assert_eq!(staged.len(), 2);
    let expected = std::fs::read_to_string(&staged[1])?;
    std::fs::remove_file(&staged[0])?;
    std::fs::write(&release, "release")?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    let message = last(&s).await?;
    assert_eq!(message["text"], "Done.", "{message}");
    assert!(
        message["limitation_codes"]
            .as_array()
            .unwrap()
            .contains(&json!("message_file_unavailable")),
        "{message}"
    );
    let attachments = message["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1, "{message}");
    assert_eq!(
        s.gw.get(attachments[0]["url"].as_str().unwrap())
            .await?
            .text,
        expected
    );
    // A crash after owner deletion but before cleanup is recovered at startup.
    s.agent.terminate().await?;
    let orphan = s.sandbox.data.join(MESSAGE_HANDOFFS).join("abandoned-turn");
    std::fs::create_dir_all(&orphan)?;
    std::fs::write(
        orphan.join(".turn"),
        serde_json::to_vec(&json!({"turn":"deleted-turn","child_session":null}))?,
    )?;
    std::fs::write(orphan.join("copy"), "Abandoned")?;
    let incomplete = s.sandbox.data.join(MESSAGE_HANDOFFS).join("ownerless");
    let temporary = s
        .sandbox
        .data
        .join(MESSAGE_HANDOFFS)
        .join(".handoff.interrupted.tmp");
    std::fs::create_dir_all(&incomplete)?;
    std::fs::create_dir_all(&temporary)?;
    std::fs::write(
        temporary.join(".turn"),
        r#"{"turn":"still-running","child_session":null}"#,
    )?;
    s.gw = s.agent.start_again().await?;
    wait_for(|| !orphan.exists()).await;
    assert!(!incomplete.exists());
    assert!(!temporary.exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn deleted_turn_handoff_is_reclaimed_without_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DELIVERABLE-DELETED-HANDOFF")?.start().await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES('abandoned',?1,'failed','Failed','2026-01-01','2026-01-01')", [&chat])?;
    drop(db);
    let orphan = s.sandbox.data.join(MESSAGE_HANDOFFS).join("abandoned");
    std::fs::create_dir_all(&orphan)?;
    std::fs::write(
        orphan.join(".turn"),
        serde_json::to_vec(&json!({"turn":"abandoned","child_session":null}))?,
    )?;
    std::fs::write(orphan.join("copy"), "Never attached")?;
    let deleted =
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?;
    assert_eq!(deleted.status, 200, "{deleted:?}");
    wait_for(|| !orphan.exists()).await;
    s.finish().await
}

pub(super) async fn wait_for(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !condition() {
        assert!(Instant::now() < deadline, "handoff condition timed out");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
pub(super) fn assert_empty(root: &Path) -> std::io::Result<()> {
    assert!(!root.exists() || std::fs::read_dir(root)?.next().is_none());
    Ok(())
}
fn copies(data: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut copies = Vec::new();
    for turn in std::fs::read_dir(data.join(MESSAGE_HANDOFFS))? {
        for file in std::fs::read_dir(turn?.path())? {
            let file = file?;
            if file.file_name() != ".turn" {
                copies.push(file.path());
            }
        }
    }
    Ok(copies)
}
