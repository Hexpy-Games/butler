//! Cancelled approval pauses release durable handoffs before the next turn.
use super::handoff::{assert_empty, wait_for};
use super::*;
use butler_e2e::e2e::scenario::Access;
use butler_platform::data_paths::MESSAGE_HANDOFFS;
use std::time::{Duration, Instant};

#[tokio::test]
async fn cancelled_deliverables_do_not_exhaust_handoff_quota() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-CANCELLED-HANDOFF")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    std::fs::write(setup.sandbox.data.join("report.md"), "Complete attachment")?;
    let s = setup.start().await?;
    let started = Instant::now();
    for index in 0..1100 {
        let prompt = format!("Deliver then request a change {index}");
        *script.prompt.lock().unwrap() = prompt.clone();
        *script.steps.lock().unwrap() = [deliver("report.md", "Report"),
            call("run_command", json!({"command":"printf changed > changed.txt","state_effect":"mutation","summary":"Write a file"})), done()].into();
        let accepted = s.gw.say("general", &prompt).await?;
        let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
        s.gw.wait_turn(
            "general",
            &turn,
            &["waiting_for_form"],
            Duration::from_secs(30),
        )
        .await?;
        let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
        wait_for(|| std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_some()))
            .await;
        let stop =
            s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
                .await?;
        assert_eq!(stop.status, 200, "{stop:?}");
        let terminal =
            s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
                .await?;
        assert_eq!(terminal["state"], "cancelled", "{terminal}");
        wait_for(|| std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_none()))
            .await;
        assert_empty(&root)?;
        script.requests.lock().unwrap().clear();
        if (index + 1) % 100 == 0 {
            eprintln!(
                "cancelled handoffs: {} in {:?}",
                index + 1,
                started.elapsed()
            );
        }
    }
    *script.prompt.lock().unwrap() = "Deliver successfully".into();
    *script.steps.lock().unwrap() = [deliver("report.md", "Report"), done()].into();
    s.turn("general", "Deliver successfully").await?;
    let message = last(&s).await?;
    let attachments = message["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1, "{message}");
    assert_eq!(
        s.gw.get(attachments[0]["url"].as_str().unwrap())
            .await?
            .text,
        "Complete attachment"
    );
    eprintln!(
        "1100 cancelled handoffs reclaimed, final attachment complete in {:?}",
        started.elapsed()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn kill_during_handoff_publication_leaves_no_ownerless_folder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-HANDOFF-INTERRUPTED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url);
    let release = setup.sandbox.root.join("handoff-release");
    let setup = setup
        .env("BUTLER_E2E_HOLD_POINT", "message_handoff_owner")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_str().unwrap());
    std::fs::write(setup.sandbox.data.join("report.md"), "Complete attachment")?;
    *script.prompt.lock().unwrap() = "Deliver".into();
    *script.steps.lock().unwrap() = [deliver("report.md", "Report"), done()].into();
    let mut s = setup.start().await?;
    s.gw.say("general", "Deliver").await?;
    wait_for(|| release.with_extension("held").exists()).await;
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    let incomplete: Vec<_> = std::fs::read_dir(&root)?
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(incomplete.len(), 1);
    assert!(!incomplete[0].join(".turn").exists());
    s.agent.kill9()?;
    std::fs::write(&release, "release")?;
    s.gw = s.agent.start_again().await?;
    assert!(incomplete.iter().all(|path| !path.exists()));
    assert_empty(&root)?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn handoff_lifetime_follows_final_or_resumable_parent_state() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("DELIVERABLE-HANDOFF-STATES")?.start().await?;
    s.agent.terminate().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    for (id, state, retryable) in [
        ("delivered", "delivered", false),
        ("failed", "failed", false),
        ("cancelled", "cancelled", false),
        ("fault", "runtime_fault", false),
        ("retry", "runtime_fault", true),
        ("suspended", "waiting_for_form", false),
    ] {
        db.execute("INSERT INTO turns(id,chat_id,state,retryable,safe_status_label,created_at,updated_at) VALUES(?1,'general',?2,?3,'State','2026-01-01','2026-01-01')", (id,state,retryable))?;
        for worker in [false, true] {
            let directory = root.join(format!("{id}-{worker}"));
            std::fs::create_dir_all(&directory)?;
            let record = if worker {
                json!({"turn":format!("child-{id}"),"parent_turn":id})
            } else {
                json!({"turn":id,"parent_turn":null})
            };
            std::fs::write(directory.join(".turn"), serde_json::to_vec(&record)?)?;
            std::fs::write(directory.join("copy"), "Complete bytes")?;
        }
    }
    drop(db);
    s.gw = s.agent.start_again().await?;
    wait_for(|| !root.join("fault-true").exists()).await;
    for id in ["delivered", "failed", "cancelled", "fault"] {
        for worker in [false, true] {
            assert!(!root.join(format!("{id}-{worker}")).exists());
        }
    }
    for id in ["retry", "suspended"] {
        for worker in [false, true] {
            assert_eq!(
                std::fs::read_to_string(root.join(format!("{id}-{worker}")).join("copy"))?,
                "Complete bytes"
            );
        }
    }
    s.finish().await
}
