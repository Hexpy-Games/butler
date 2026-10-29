//! Cancelled approval pauses release durable handoffs before the next turn.
use super::super::browser_approval::host::Host;
use super::handoff::{assert_empty, wait_for};
use super::*;
use butler_platform::data_paths::MESSAGE_HANDOFFS;
use std::time::{Duration, Instant};

#[tokio::test]
async fn cancelled_and_delivered_handoffs_return_to_baseline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-CANCELLED-HANDOFF")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    std::fs::write(setup.sandbox.data.join("report.md"), "Complete attachment")?;
    let s = setup.start().await?;
    let host = Host::attach(&s).await?;
    let started = Instant::now();
    let prompt = "Deliver then request a change".to_owned();
    *script.prompt.lock().unwrap() = prompt.clone();
    *script.steps.lock().unwrap() = [
            deliver("report.md", "Report"),
            call("tool_call", json!({"id":"native:browser_observe","arguments":{"tab":"pub"}})),
            call("tool_call", json!({"id":"native:browser_act","arguments":{"tab":"pub","observation":"obs-1","steps":[{"action":"click","ref":"e9"}]}})), done()
        ].into();
    let accepted = s.gw.say("general", &prompt).await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    wait_state(&s, &turn, "waiting_for_form").await?;
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["approval"]["risk"], "high");
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    wait_for(|| std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_some())).await;
    let stop =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert_eq!(stop.status, 202, "{stop:?}");
    wait_state(&s, &turn, "cancelled").await?;
    wait_for(|| std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_none())).await;
    assert_empty(&root)?;
    *script.prompt.lock().unwrap() = "Deliver successfully".into();
    *script.steps.lock().unwrap() = [deliver("report.md", "Report"), done()].into();
    let accepted = s.gw.say("general", "Deliver successfully").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    wait_state(&s, &turn, "delivered").await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let message = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| {
            message["turn_id"] == turn
                && message["role"] == "assistant"
                && message["status"] == "delivered"
        })
        .unwrap();
    let attachments = message["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1, "{message}");
    assert_eq!(
        s.gw.get(attachments[0]["url"].as_str().unwrap())
            .await?
            .text,
        "Complete attachment"
    );
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    wait_for(|| std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_none())).await;
    assert_empty(&root)?;
    eprintln!(
        "Cancelled and delivered handoffs reclaimed, final attachment complete in {:?}",
        started.elapsed()
    );
    drop(host);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cancellation_during_handoff_promotion_finishes_and_reclaims() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-HANDOFF-CANCEL-RACE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let release = setup.sandbox.root.join("handoff-release");
    let setup = setup
        .env("BUTLER_E2E_HOLD_POINT", "message_handoff_owner")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_str().unwrap());
    std::fs::write(setup.sandbox.data.join("report.md"), "Complete attachment")?;
    *script.prompt.lock().unwrap() = "Deliver then pause".into();
    *script.steps.lock().unwrap() = [
        deliver("report.md", "Report"),
        call("tool_call", json!({"id":"native:browser_observe","arguments":{"tab":"pub"}})),
        call("tool_call", json!({"id":"native:browser_act","arguments":{"tab":"pub","observation":"obs-1","steps":[{"action":"click","ref":"e9"}]}})),
        done(),
    ].into();
    let s = setup.start().await?;
    let host = Host::attach(&s).await?;
    let accepted = s.gw.say("general", "Deliver then pause").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    wait_for(|| release.with_extension("held").exists()).await;
    let stop =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert_eq!(stop.status, 202, "{stop:?}");
    std::fs::write(&release, "release")?;
    wait_state(&s, &turn, "cancelled").await?;
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    wait_for(|| std::fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_none())).await;
    assert_empty(&root)?;
    drop(host);
    s.finish().await?;
    server.abort();
    Ok(())
}

// The legacy /turns collection is bounded; current state comes from the session projection.
async fn wait_state(s: &Scenario, turn: &str, expected: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200, "{view:?}");
        let found = ["active_turn", "latest_turn"].iter().any(|key| {
            let row = &view.data()[key];
            row["id"] == turn && row["state"] == expected
        });
        if found {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let db = rusqlite::Connection::open_with_flags(
                s.sandbox.data.join("app-server/butler-client.sqlite"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let state: (String, Option<String>) = db.query_row(
                "SELECT state,safe_error_code FROM turns WHERE id=?1",
                [turn],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            panic!(
                "turn {turn} did not reach {expected}; database={state:?}; active={} {}; latest={} {}",
                view.data()["active_turn"]["id"],
                view.data()["active_turn"]["state"],
                view.data()["latest_turn"]["id"],
                view.data()["latest_turn"]["state"]
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn kill_during_handoff_publication_leaves_no_ownerless_folder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-HANDOFF-INTERRUPTED")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
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
    use butler_e2e::e2e::task_graph::{Attempt, GraphBuilder, actions};
    butler_e2e::gate!();
    let error = |error: butler_e2e::e2e::task_graph::Error| HarnessError(error.to_string());
    let mut s = Setup::new("DELIVERABLE-HANDOFF-STATES")?.start().await?;
    s.agent.terminate().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let session: String = db.query_row(
        "SELECT COALESCE(runtime_session_hint,id) FROM chats WHERE id='general'",
        [],
        |row| row.get(0),
    )?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await.map_err(error)?;
    let mut cases = Vec::new();
    for state in ["cancelled", "failed", "runtime_fault", "delivered"] {
        let (parent, mut steward) = builder.unplanned(&session, 1, state).await.map_err(error)?;
        builder
            .plan(&mut steward, "workers", actions(1))
            .await
            .map_err(error)?;
        builder
            .review(&mut steward, "plan", "accept", json!([]))
            .await
            .map_err(error)?;
        let worker = builder
            .worker(&steward, "a", "Prepare the file")
            .await
            .map_err(error)?;
        builder
            .result(&worker, "success", "File ready")
            .await
            .map_err(error)?;
        let steward = Attempt {
            task: String::new(),
            session: steward.scope.session_id,
            turn: steward.scope.turn_id,
        };
        builder
            .result(&steward, "success", "Results ready")
            .await
            .map_err(error)?;
        seed_parent(&db, &parent.scope.turn_id)?;
        let consumer = format!("consumer-{state}");
        seed_parent(&db, &consumer)?;
        cases.push((state, parent.scope.turn_id, consumer, steward, worker));
    }
    builder.close().await.map_err(error)?;
    let btcc = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    // These fixtures model completed child executions, with delivery already submitted.
    btcc.execute("UPDATE btcc_turns SET semantic_state='delivered'", [])?;
    btcc.execute("UPDATE btcc_subsession_outbox SET status='delivered'", [])?;
    let root = s.sandbox.data.join(MESSAGE_HANDOFFS);
    for (state, parent, consumer, steward, worker) in &cases {
        let (relation, result): (String, String) = btcc.query_row(
            "SELECT relation_id,result_id FROM btcc_subsession_outbox WHERE parent_turn_id=?1",
            [parent],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        // Seed the admission row the way admission stores it: by canonical client identity.
        let client = butler_gateway::gateway::admission_client_id(&format!(
            "subsession-result:{}",
            butler_turn::btcc::digest_identity(&format!("{relation}\0{result}"))
        ));
        db.execute("INSERT INTO session_queued_messages(id,chat_id,text,client_message_id,controls_json,attachments_json,state,turn_id,created_at,updated_at) VALUES(?1,'general','Result',?2,'{}','[]','dispatched',?3,'2026-01-01','2026-01-01')", rusqlite::params![state, client, consumer])?;
        for (name, turn, session) in [
            ("root", parent.as_str(), None),
            (
                "steward",
                steward.turn.as_str(),
                Some(steward.session.as_str()),
            ),
            (
                "worker",
                worker.turn.as_str(),
                Some(worker.session.as_str()),
            ),
        ] {
            let path = root.join(format!("{state}-{name}"));
            std::fs::create_dir_all(&path)?;
            std::fs::write(path.join("copy"), "Complete bytes")?;
            std::fs::write(
                path.join(".turn"),
                serde_json::to_vec(&json!({"turn":turn,"child_session":session}))?,
            )?;
        }
    }
    drop(btcc);
    s.gw = s.agent.start_again().await?;
    assert_retained(&root, &cases.iter().map(|c| c.0).collect::<Vec<_>>())?;
    for (state, parent, consumer, _, _) in &cases {
        // A retryable fault and approval pause both keep all three handoffs alive.
        db.execute(
            "UPDATE turns SET state='runtime_fault',retryable=1 WHERE id=?1",
            [parent],
        )?;
        notify_handoffs(&root, state)?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_retained(&root, &[*state])?;
        db.execute(
            "UPDATE turns SET state=?2,retryable=0 WHERE id=?1",
            rusqlite::params![parent, state],
        )?;
        notify_handoffs(&root, state)?;
        wait_for(|| !root.join(format!("{state}-root")).exists()).await;
        if *state == "delivered" {
            // Submitted results still belong to their active consuming follow-up.
            for name in ["steward", "worker"] {
                assert!(root.join(format!("{state}-{name}/copy")).exists());
            }
            db.execute("UPDATE turns SET state='delivered' WHERE id=?1", [consumer])?;
            notify_handoffs(&root, state)?;
        }
        wait_for(|| {
            ["steward", "worker"]
                .iter()
                .all(|name| !root.join(format!("{state}-{name}")).exists())
        })
        .await;
        eprintln!("handoff final state={state}: root, steward and worker reclaimed");
    }
    assert_empty(&root)?;
    drop(db);
    s.finish().await
}

fn seed_parent(db: &rusqlite::Connection, id: &str) -> rusqlite::Result<usize> {
    db.execute("INSERT INTO turns(id,chat_id,state,retryable,safe_status_label,created_at,updated_at) VALUES(?1,'general','waiting_for_form',0,'State','2026-01-01','2026-01-01')", [id])
}

fn assert_retained(root: &std::path::Path, states: &[&str]) -> Result<(), HarnessError> {
    for state in states {
        for name in ["root", "steward", "worker"] {
            assert_eq!(
                std::fs::read_to_string(root.join(format!("{state}-{name}/copy")))?,
                "Complete bytes"
            );
        }
    }
    Ok(())
}

fn notify_handoffs(root: &std::path::Path, state: &str) -> Result<(), HarnessError> {
    use std::io::Write;
    for name in ["root", "steward", "worker"] {
        let path = root.join(format!("{state}-{name}/.turn"));
        if path.exists() {
            // A close-write notification asks the projection to observe the new DB state.
            std::fs::OpenOptions::new()
                .append(true)
                .open(path)?
                .write_all(b" ")?;
        }
    }
    Ok(())
}
