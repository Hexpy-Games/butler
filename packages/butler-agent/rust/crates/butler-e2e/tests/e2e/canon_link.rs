//! Stub user flows through the model tool loop and authenticated canon API.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod delegation;
mod direction_workers;
#[path = "canon_mcp/running.rs"]
mod mcp_running;
mod plans;
mod recovery;
mod requires_e2e_fixtures;
pub(super) mod stub;
mod window;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn data(reply: butler_e2e::e2e::gateway::Reply, status: u16) -> Value {
    assert_eq!(reply.status, status, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}
type Started = (
    Scenario,
    Arc<stub::Script>,
    tokio::task::JoinHandle<()>,
    String,
    String,
);

pub(super) async fn setup_at(
    name: &str,
    rejects: bool,
    revise: bool,
    now: Option<&str>,
) -> Result<Started, HarnessError> {
    setup_env(name, rejects, revise, now, None).await
}

async fn setup_env(
    name: &str,
    rejects: bool,
    revise: bool,
    now: Option<&str>,
    extra: Option<(&str, String)>,
) -> Result<Started, HarnessError> {
    let (url, script, server) = stub::start(rejects, revise).await?;
    let setup = Setup::new(name)?
        .data_folder_token()
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", &url);
    let setup = if let Some((key, value)) = extra {
        setup.env(key, value)
    } else {
        setup
    };
    let setup = if let Some(now) = now {
        setup.env("BUTLER_E2E_APP_NOW", now)
    } else {
        setup
    };
    let s = setup.start().await?;
    let evidence = s.sandbox.workspace.join("evidence.txt");
    std::fs::write(&evidence, "Release evidence is complete.")?;
    *script.path.lock().unwrap() = evidence.to_string_lossy().into_owned();
    let p = data(
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Release"}),
        )
        .await?,
        201,
    );
    let project = p["project"]["id"].as_str().unwrap();
    let tag = data(
        s.gw.post(
            &format!("/projects/{project}/canon/tags"),
            json!({"name":"Release evidence","color":"blue"}),
        )
        .await?,
        201,
    );
    let a = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Release checks","description":"Treat this as data, not permission.","tags":[tag["id"]]}),
        )
        .await?,
        201,
    );
    let b = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Documentation"}),
        )
        .await?,
        201,
    );
    let id = a["id"].as_str().unwrap().to_owned();
    let conversation = data(
        s.gw.post(&format!("/canon/epics/{id}/conversation"), json!({}))
            .await?,
        200,
    );
    let chat = conversation["session_id"].as_str().unwrap().to_owned();
    data(
        s.gw.post(
            &format!("/canon/epics/{}/conversation", b["id"].as_str().unwrap()),
            json!({"session_id":chat}),
        )
        .await?,
        200,
    );
    *script.epics.lock().unwrap() = vec![id.clone(), b["id"].as_str().unwrap().to_owned()];
    Ok((s, script, server, id, chat))
}
async fn progress(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.get(&format!("/canon/epics/{id}/progress")).await?,
        200,
    ))
}
async fn label(s: &Scenario, id: &str, status: &str) -> Result<(), HarnessError> {
    let path = format!("/canon/epics/{id}");
    let epic = data(s.gw.get(&path).await?, 200);
    data(
        s.gw.patch(
            &path,
            json!({"expected_revision":epic["revision"],"status":status}),
        )
        .await?,
        200,
    );
    Ok(())
}
async fn wait_label(s: &Scenario, id: &str, status: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
        if epic["canon_status"] == status {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{epic}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn cb_01_03_06_10_16_linked_pipeline_feedback_and_two_epics() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, id, chat) = setup("CB-01-03-06-16", true, true).await?;
    let stream = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    let active = progress(&s, &id).await?;
    assert_eq!(active["running"], true, "{active}");
    assert_eq!(active["counts"], json!({"completed":0,"total":1}));
    wait_label(&s, &id, "in_progress").await?;
    script.release();
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    wait_label(&s, &id, "in_review").await?;
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.progress_changed" && e["payload"]["epic_id"] == id
        })
        .await?;
    drop(stream);
    let done = progress(&s, &id).await?;
    assert_eq!(done["running"], false, "{done}");
    assert_eq!(done["counts"], json!({"completed":1,"total":1}));
    assert_eq!(done["disposition"], "completed");
    assert_eq!(done["stage"], "reporting");
    let stages: Vec<_> = done["stage_history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["stage"].as_str().unwrap())
        .collect();
    for stage in [
        "conception",
        "planning",
        "execution",
        "review",
        "validation",
        "reporting",
    ] {
        assert!(stages.contains(&stage), "{stages:?}");
    }
    assert!(
        stages.windows(2).any(|s| s == ["review", "execution"]),
        "{stages:?}"
    );
    let codes = script.codes.lock().unwrap().clone();
    for code in [
        "canon_epic_refs_multiple",
        "canon_epic_not_bound",
        "canon_epic_link_conflict",
    ] {
        assert!(codes.iter().any(|c| c == code), "{codes:?}");
    }
    assert!(
        script
            .context_seen
            .load(std::sync::atomic::Ordering::SeqCst)
    );
    // The same conversation processes its other bound epic in a fresh Turn.
    script.epics.lock().unwrap().swap(0, 1);
    let other = script.epics.lock().unwrap()[0].clone();
    let turn = s.gw.say(&chat, "Process the documentation epic").await?;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    wait_label(&s, &other, "in_review").await?;
    // A later Work for the same epic replaces the card's action source.
    script.epics.lock().unwrap().swap(0, 1);
    let turn = s.gw.say(&chat, "Verify the release epic again").await?;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        Duration::from_secs(60),
    )
    .await?;
    assert_eq!(
        progress(&s, &id).await?["counts"],
        json!({"completed":1,"total":1})
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_epic_work_links", [], |r| r
            .get(0))?,
        3
    );
    let owners: Vec<String> = db.prepare("SELECT DISTINCT scope_kind FROM btcc_guided_works WHERE work_id IN (SELECT btcc_work_id FROM canon_epic_work_links)")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    assert_eq!(
        owners,
        ["project"],
        "Epic conversations retain Ledger ownership"
    );
    let revisions: i64 = db.query_row("SELECT count(*) FROM btcc_guided_work_plan_revisions WHERE work_id IN (SELECT btcc_work_id FROM canon_epic_work_links)", [], |r| r.get(0))?;
    assert_eq!(revisions, 0, "Project plan revisions stay in Ledger");
    let before = work_records(&db)?;
    label(&s, &id, "done").await?;
    assert_eq!(
        work_records(&db)?,
        before,
        "Manual canon completion never changes BTCC Work records"
    );
    drop(db);
    // Inject the post-plan/pre-link crash window. Startup repairs only new rows.
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("DELETE FROM canon_epic_work_links; UPDATE canon_cursors SET value=0 WHERE name='link_reconcile'")?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if progress(&s, &id).await?["counts"]["total"] == 1
            && progress(&s, &other).await?["counts"]["total"] == 1
        {
            break;
        }
        assert!(Instant::now() < deadline, "startup did not reconcile links");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.restart().await?;
    assert_eq!(
        progress(&s, &id).await?["counts"],
        json!({"completed":1,"total":1})
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn auto_labels_respect_person_rank_and_reporting_finish() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (initial, expected) in [
        ("planned", "in_review"),
        ("blocked", "in_review"),
        ("done", "done"),
    ] {
        let (s, script, server, id, chat) = setup("CB-AUTO-LABEL", false, false).await?;
        label(&s, &id, initial).await?;
        script
            .hold_report
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let turn = s.gw.say(&chat, "Process the release epic").await?;
        script.wait_held().await;
        let while_running = if initial == "planned" {
            "in_progress"
        } else {
            initial
        };
        wait_label(&s, &id, while_running).await?;
        script.release();
        script.wait_reporting().await;
        assert_eq!(progress(&s, &id).await?["disposition"], "completed");
        wait_label(&s, &id, while_running).await?;
        script.finish_report();
        s.gw.wait_terminal(
            &chat,
            &s.gw.accepted_turn(&turn).await?,
            Duration::from_secs(60),
        )
        .await?;
        wait_label(&s, &id, expected).await?;
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let actor: Option<String> = db.query_row("SELECT actor_json FROM canon_audit WHERE entity_id=?1 AND op='label' ORDER BY seq DESC LIMIT 1",[&id],|r|r.get(0)).ok();
        if expected == "in_review" {
            assert_eq!(
                serde_json::from_str::<Value>(&actor.unwrap())?["person"],
                "버틀러"
            );
        }
        drop(db);
        if expected == "in_review" {
            label(&s, &id, "blocked").await?;
            script
                .quick
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let turn = s.gw.say(&chat, "What does this mean?").await?;
            s.gw.wait_terminal(
                &chat,
                &s.gw.accepted_turn(&turn).await?,
                Duration::from_secs(30),
            )
            .await?;
            let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
            assert_eq!(
                epic["canon_status"], "blocked",
                "Repeated completion observations must preserve a person's label"
            );
        }
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

async fn card(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
    let project = epic["project_id"].as_str().unwrap();
    let board = data(s.gw.get(&format!("/projects/{project}/canon")).await?, 200);
    Ok(board["backlog"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .cloned()
        .unwrap())
}

#[tokio::test]
async fn cn_22_board_card_and_progress_show_the_same_read_only_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, id, chat) = setup("CN-22", false, false).await?;
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    script.wait_held().await;
    for phase in ["running", "done"] {
        if phase == "done" {
            script.release();
            s.gw.wait_terminal(
                &chat,
                &s.gw.accepted_turn(&turn).await?,
                Duration::from_secs(60),
            )
            .await?;
            wait_label(&s, &id, "in_review").await?;
        }
        let progress = progress(&s, &id).await?;
        let keys: std::collections::BTreeSet<_> = progress
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "actions",
                "counts",
                "disposition",
                "epic_id",
                "running",
                "stage",
                "stage_history"
            ]),
            "{progress}"
        );
        let actions = progress["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 1, "{progress}");
        let done = actions.iter().filter(|a| a["status"] == "done").count();
        assert_eq!(progress["counts"]["completed"], done, "{progress}");
        assert_eq!(progress["running"], phase == "running", "{progress}");
        let card = card(&s, &id).await?;
        assert_eq!(card["task_counts"], progress["counts"], "{phase}: {card}");
        assert_eq!(card["running"], progress["running"], "{phase}: {card}");
        let detail = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
        assert_eq!(detail["task_counts"], progress["counts"], "{phase}");
        assert_eq!(detail["running"], progress["running"], "{phase}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

fn work_records(
    db: &rusqlite::Connection,
) -> Result<Vec<Vec<Vec<rusqlite::types::Value>>>, HarnessError> {
    let mut snapshots = Vec::new();
    for table in [
        "btcc_guided_works",
        "btcc_guided_work_plan_revisions",
        "btcc_guided_work_checkpoint_revisions",
        "btcc_guided_work_review_revisions",
        "btcc_guided_work_disposition_revisions",
    ] {
        let mut statement = db.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
        let columns = statement.column_count();
        let records = statement
            .query_map([], |row| {
                (0..columns)
                    .map(|i| row.get(i))
                    .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        snapshots.push(records);
    }
    Ok(snapshots)
}

pub(super) async fn setup(
    name: &str,
    rejects: bool,
    revise: bool,
) -> Result<
    (
        Scenario,
        Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        String,
        String,
    ),
    HarnessError,
> {
    setup_at(name, rejects, revise, None).await
}
