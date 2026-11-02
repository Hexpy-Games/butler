//! Composer permission changes commit with the next exact approval answer.
use super::stub::{self, Script, call};
use super::{assert_counts, delivered, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::sync::Arc;

mod isolation;
mod lineage;
mod upgrade;

const PROMPT: &str = "Run the two requested checks.";

async fn setup() -> Result<(Scenario, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("COMPOSER-PERMISSION")?
        .access(Access::Auto)
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    script
        .rounds
        .lock()
        .unwrap()
        .insert(PROMPT.into(), vec![command("first"), command("second")]);
    Ok((s, script, server))
}

fn command(id: &str) -> Value {
    call(
        id,
        "run_command",
        &json!({"command":format!("echo {id}"),"cwd":".",
        "sandbox":"none","state_effect":"mutation","summary":"Check status"}),
    )
}

async fn controls(s: &Scenario, mode: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.patch("/sessions/general/controls", json!({"access_mode":mode}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(())
}

async fn answer(s: &Scenario, reference: &str, action: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/{action}?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    Ok(())
}

#[tokio::test]
async fn widening_at_allow_or_deny_survives_restart_and_duplicate_answers()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for action in ["allow", "deny"] {
        let (mut s, script, server) = setup().await?;
        let turn = paused(&s, "general", PROMPT).await?;
        let cards = s.gw.approval_requests("general").await?;
        assert_eq!(cards.len(), 1);
        assert_eq!(
            cards[0]["approval"]["operation"]["allow_conversation"],
            false
        );
        let reference = cards[0]["request_ref"].as_str().unwrap();
        controls(&s, "full_access").await?;
        s.restart().await?;
        answer(&s, reference, action).await?;
        delivered(&s, "general", &turn).await?;
        assert_counts(&s, &turn, 1, 0)?;
        controls(&s, "ask_first").await?;
        answer(&s, reference, action).await?;
        assert_revision(&s, &turn, "full_access", 1)?;
        let requests = script.requests_for(PROMPT);
        assert_eq!(requests.len(), 3);
        let inputs = requests.last().unwrap()["input"].to_string();
        assert!(inputs.contains("second"), "{inputs}");
        assert_eq!(
            inputs.contains("authority_request_denied"),
            action == "deny",
            "{inputs}"
        );
        assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

fn assert_revision(s: &Scenario, turn: &str, mode: &str, count: u64) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (saved, revisions): (String, u64) = db.query_row(
        "SELECT composer_access_mode,count(*) FROM btcc_authority_requests WHERE composer_root_turn_id=?1",
        [turn],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert_eq!((saved, revisions), (mode.into(), count));
    Ok(())
}

#[tokio::test]
async fn non_reusable_approval_rejects_a_conversation_grant() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server) = setup().await?;
    paused(&s, "general", PROMPT).await?;
    let cards = s.gw.approval_requests("general").await?;
    let reference = cards[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"conversation"}),
        )
        .await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    assert_eq!(s.gw.approval_requests("general").await?.len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn narrowing_at_the_next_answer_rechecks_the_following_command() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup().await?;
    controls(&s, "ask_first").await?;
    let reads = [read(&s, "first")?, read(&s, "sibling")?];
    script
        .rounds
        .lock()
        .unwrap()
        .insert(PROMPT.into(), vec![json!(reads), command("third")]);
    let turn = paused(&s, "general", PROMPT).await?;
    let cards = pending(&s, 2).await?;
    controls(&s, "full_access").await?;
    answer(&s, cards[1]["request_ref"].as_str().unwrap(), "allow").await?;
    controls(&s, "ask_first").await?;
    answer(&s, cards[0]["request_ref"].as_str().unwrap(), "allow").await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let pending = s.gw.approval_requests("general").await?;
        if let Some(card) = pending
            .iter()
            .find(|c| c["approval"]["operation"]["command"] == "echo third")
        {
            answer(&s, card["request_ref"].as_str().unwrap(), "deny").await?;
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "third command did not ask: {pending:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    delivered(&s, "general", &turn).await?;
    let requests = script.requests_for(PROMPT);
    let inputs = requests.last().unwrap()["input"].to_string();
    assert!(
        inputs.contains("first-read") && inputs.contains("sibling-read"),
        "{inputs}"
    );
    assert_counts(&s, &turn, 3, 0)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let modes = db
        .prepare(
            "SELECT composer_access_mode FROM btcc_authority_requests WHERE composer_root_turn_id=?1 ORDER BY composer_revision",
        )?
        .query_map([&turn], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(modes, ["full_access", "ask_first"]);
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

fn read(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let path = s.sandbox.data.join(format!("{id}.txt"));
    std::fs::write(&path, format!("{id}-read"))?;
    Ok(call(
        id,
        "read_file",
        &json!({"requests":[{"path":path,"max_bytes":2048}]}),
    ))
}

#[tokio::test]
async fn readonly_change_keeps_the_allowed_exact_action_and_denies_the_next()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for bridge in [false, true] {
        let (s, script, server) = setup().await?;
        script.rounds.lock().unwrap().insert(
            PROMPT.into(),
            vec![
                write("first-write", "approved.txt", bridge),
                write("next-write", "denied.txt", bridge),
            ],
        );
        let turn = paused(&s, "general", PROMPT).await?;
        let cards = s.gw.approval_requests("general").await?;
        controls(&s, "read_only").await?;
        answer(&s, cards[0]["request_ref"].as_str().unwrap(), "allow").await?;
        delivered(&s, "general", &turn).await?;
        let requests = script.requests_for(PROMPT);
        let inputs = requests.last().unwrap()["input"].as_array().unwrap();
        let outputs: Vec<_> = inputs
            .iter()
            .filter_map(|item| item["output"].as_str())
            .collect();
        assert_eq!(outputs.len(), 2, "{outputs:?}");
        let denial = if bridge {
            "disabled_tool"
        } else {
            // A refreshed read-only surface rejects native writes before dispatch.
            assert!(
                !butler_e2e::e2e::chatgpt_wire::tools(requests.last().unwrap())
                    .any(|tool| tool["name"] == "write_file"),
                "read-only must not offer write_file"
            );
            "tool_unavailable"
        };
        assert!(outputs[1].contains(denial), "{outputs:?}");
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let workspace: String = db.query_row(
            "SELECT workspace_path FROM btcc_authority_requests WHERE source_turn_id=?1",
            [&turn],
            |row| row.get(0),
        )?;
        let workspace = std::path::Path::new(&workspace);
        assert_eq!(
            std::fs::read_to_string(workspace.join("approved.txt"))?,
            "checked"
        );
        assert!(!workspace.join("denied.txt").exists());
        drop(db);
        assert_revision(&s, &turn, "read_only", 1)?;
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

fn write(id: &str, path: &str, bridge: bool) -> Value {
    let args = json!({"path":path,"content":"checked"});
    if bridge {
        call(
            id,
            "tool_call",
            &json!({"id":"native:write_file","arguments":args}),
        )
    } else {
        call(id, "write_file", &args)
    }
}

async fn pending(s: &Scenario, count: usize) -> Result<Vec<Value>, HarnessError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let cards = s.gw.approval_requests("general").await?;
        if cards.len() == count {
            return Ok(cards);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "approvals: {cards:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
