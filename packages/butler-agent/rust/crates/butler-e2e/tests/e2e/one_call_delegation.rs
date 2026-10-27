//! One-call handoff, restart, revision gate, settlement and follow-up through the host.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test fixture assertions"
)]
mod project;
mod project_outcomes;
mod stub;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn steward_plan_gate_restart_settlement_and_one_call_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("ONE-CALL-DELEGATION")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_E2E_HOLD_QUEUE_CLAIMS", "1");
    let release = setup.sandbox.data.join("e2e-queue-claims-release");
    std::fs::write(&release, "release")?;
    *script.queue_release.lock().unwrap() = Some(release);
    let mut s = setup.start().await?;
    let workspace = s.sandbox.workspace.clone();
    *script.workspace.lock().unwrap() = workspace.clone();
    std::fs::write(workspace.join("source.txt"), "source evidence")?;
    s.turn("general", stub::REQUEST).await?;
    let first = relations(&s)?;
    assert_eq!(first.len(), 1);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let admitted: i64 = db.query_row("SELECT count(*) FROM btcc_turns t JOIN btcc_subsession_delegations d ON d.child_turn_id=t.turn_id", [], |row| row.get(0))?;
    assert_eq!(
        admitted, 0,
        "Restart at the durable dispatch boundary, before child admission"
    );
    drop(db);
    s.agent.launch.remove_env("BUTLER_E2E_HOLD_QUEUE_CLAIMS");
    s.crash_and_restart().await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .expect("Steward reached the pre-plan hold")
        .unwrap()
        .forget();
    assert!(!workspace.join("early.txt").exists());
    assert!(!workspace.join("command.txt").exists());
    script.release.add_permits(1);
    wait_settled(&s, 1).await?;
    assert_eq!(
        relations(&s)?,
        first,
        "Restart must retain the same child relation"
    );
    verify(&s, &script, 1)?;
    *script.relation.lock().unwrap() = first[0].clone();
    s.turn("general", stub::FOLLOWUP).await?;
    wait_settled(&s, 2).await?;
    verify(&s, &script, 2)?;
    assert_eq!(
        std::fs::read_to_string(workspace.join("evidence.txt"))?,
        "verified"
    );
    assert!(!workspace.join("revision.txt").exists());
    let graphs = s.gw.get("/sessions/general/task-graphs").await?;
    assert_eq!(graphs.status, 200);
    assert_eq!(graphs.data()["total"], 2);
    for graph in graphs.data()["graphs"].as_array().unwrap() {
        let id = graph["graph_id"].as_str().unwrap();
        let detail = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
        assert_eq!(detail.status, 200);
        assert!(
            detail.text.contains("Verify workspace evidence"),
            "{}",
            detail.text
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn steward_mutations_require_a_review_of_the_current_plan() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("STEWARD-PLAN-GATE")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let workspace = s.sandbox.workspace.clone();
    *script.workspace.lock().unwrap() = workspace.clone();
    std::fs::write(workspace.join("source.txt"), "source evidence")?;
    s.turn("general", stub::REQUEST).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .expect("Steward inspected before planning")
        .unwrap()
        .forget();
    assert!(!workspace.join("early.txt").exists());
    assert!(!workspace.join("command.txt").exists());
    script.release.add_permits(1);
    wait_settled(&s, 1).await?;
    verify(&s, &script, 1)?;
    assert!(!workspace.join("revision.txt").exists());
    assert_eq!(
        std::fs::read_to_string(workspace.join("evidence.txt"))?,
        "verified"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn an_old_result_turn_can_acknowledge_runtime_settlement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script
        .legacy_closeout
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let s = Setup::new("STEWARD-LEGACY-CLOSEOUT")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    *script.workspace.lock().unwrap() = s.sandbox.workspace.clone();
    std::fs::write(s.sandbox.workspace.join("source.txt"), "source evidence")?;
    s.turn("general", stub::REQUEST).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .expect("Steward inspected before planning")
        .unwrap()
        .forget();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let work: String = db.query_row("SELECT json_extract(packet_json,'$.parent_work_ref.work_id') FROM btcc_subsession_delegations LIMIT 1", [], |row| row.get(0))?;
    *script.parent_work.lock().unwrap() = work.clone();
    script.release.add_permits(1);
    wait_settled(&s, 1).await?;
    let response: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='record_work_disposition' AND json_extract(arguments_json,'$.work_id')=?1",
        [&work], |row| row.get(0))?;
    let response: Value = serde_json::from_str(&response)?;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["already_settled"], true, "{response}");
    let (status, dispositions): (String,i64) = db.query_row("SELECT status,(SELECT count(*) FROM btcc_guided_work_disposition_revisions WHERE work_id=?1) FROM btcc_guided_works WHERE work_id=?1", [&work], |row| Ok((row.get(0)?,row.get(1)?)))?;
    assert_eq!(status, "completed");
    assert_eq!(
        dispositions, 1,
        "The old model does not write a second disposition"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn an_accepted_legacy_steward_plan_keeps_its_revision_and_review() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script
        .legacy_plan
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let s = Setup::new("STEWARD-LEGACY-PLAN")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    *script.workspace.lock().unwrap() = s.sandbox.workspace.clone();
    std::fs::write(s.sandbox.workspace.join("source.txt"), "source evidence")?;
    s.turn("general", stub::REQUEST).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .expect("Steward inspected before planning")
        .unwrap()
        .forget();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (packet, plans, reviews): (String,i64,i64) = db.query_row(
        "SELECT d.packet_json,(SELECT count(*) FROM btcc_guided_work_plan_revisions WHERE work_id=json_extract(d.packet_json,'$.parent_work_ref.work_id')),(SELECT count(*) FROM btcc_guided_work_review_revisions WHERE work_id=json_extract(d.packet_json,'$.parent_work_ref.work_id')) FROM btcc_subsession_delegations d LIMIT 1",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
    let packet: Value = serde_json::from_str(&packet)?;
    assert_eq!(
        (plans, reviews),
        (1, 1),
        "Reuse the accepted Plan without a new revision or review"
    );
    let plan: String = db.query_row(
        "SELECT plan_revision_id FROM btcc_guided_work_plan_revisions WHERE work_id=?1",
        [packet["parent_work_ref"]["work_id"].as_str().unwrap()],
        |row| row.get(0),
    )?;
    let review: String = db.query_row(
        "SELECT review_revision_id FROM btcc_guided_work_review_revisions WHERE work_id=?1",
        [packet["parent_work_ref"]["work_id"].as_str().unwrap()],
        |row| row.get(0),
    )?;
    assert_eq!(packet["parent_work_ref"]["plan_revision_id"], plan);
    assert_eq!(packet["parent_work_ref"]["review_revision_id"], review);
    assert_eq!(packet["acceptance_criteria"], json!(["Legacy acceptance"]));
    drop(db);
    script.release.add_permits(1);
    wait_settled(&s, 1).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

fn relations(s: &butler_e2e::e2e::scenario::Scenario) -> Result<Vec<String>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut query = db.prepare("SELECT r.relation_id FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE json_extract(d.packet_json,'$.child_role')='steward' ORDER BY ordinal")?;
    Ok(query
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

async fn wait_settled(
    s: &butler_e2e::e2e::scenario::Scenario,
    count: usize,
) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages
            .iter()
            .filter(|message| message["text"] == stub::ANSWER)
            .count()
            == count
        {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "Result stalled: {messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn verify(
    s: &butler_e2e::e2e::scenario::Scenario,
    script: &stub::Script,
    count: usize,
) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let parents: i64 = db.query_row(
        "SELECT count(*) FROM btcc_guided_works WHERE work_id IN (SELECT json_extract(packet_json,'$.parent_work_ref.work_id') FROM btcc_subsession_delegations) AND status='completed'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(usize::try_from(parents).unwrap(), count);
    let plans: i64 = db.query_row("SELECT count(*) FROM btcc_guided_work_plan_revisions WHERE work_id IN (SELECT json_extract(packet_json,'$.parent_work_ref.work_id') FROM btcc_subsession_delegations) AND execution_mode='steward'", [], |row| row.get(0))?;
    assert_eq!(
        usize::try_from(plans).unwrap(),
        count,
        "Restart and replay create one parent Plan per handoff"
    );
    let reviews: i64 = db.query_row("SELECT count(*) FROM btcc_guided_work_review_revisions WHERE work_id IN (SELECT json_extract(packet_json,'$.parent_work_ref.work_id') FROM btcc_subsession_delegations)", [], |row| row.get(0))?;
    assert_eq!(reviews, 0, "No runtime-generated parent reviews");
    let calls: i64 = db.query_row("SELECT count(*) FROM btcc_guided_tool_calls c JOIN btcc_turns t USING(turn_id) WHERE t.session_id IN (SELECT parent_session_id FROM btcc_session_relations) AND c.tool_name IN ('start_work','replace_work_plan','record_work_review','record_work_disposition')", [], |row| row.get(0))?;
    assert_eq!(calls, 0);
    let requests = script.requests.lock().unwrap();
    let outputs: Vec<_> = requests.iter().flat_map(stub::outputs).collect();
    let observation: (String, String) = db.query_row("SELECT arguments_json,result_json FROM btcc_guided_tool_calls WHERE tool_name='read_file' ORDER BY rowid LIMIT 1", [], |row| Ok((row.get(0)?,row.get(1)?)))?;
    assert!(
        outputs
            .iter()
            .any(|output| output.to_string().contains("source evidence")),
        "Read-only inspection must succeed: {observation:?}"
    );
    let refused: Vec<_> = outputs
        .iter()
        .filter(|output| output["error"]["code"] == "steward_plan_review_required")
        .collect();
    assert!(refused.len() >= 3 * count);
    for output in refused {
        assert_eq!(output["ok"], false);
        assert_eq!(output["error"]["recoverable"], true);
        assert_eq!(
            output["error"]["next_action"][0]["tool"],
            "replace_work_plan"
        );
    }
    let gate_results = {
        let mut query = db.prepare("SELECT result_json FROM btcc_guided_tool_calls WHERE json_extract(result_json,'$.error.code')='steward_plan_review_required'")?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    assert_eq!(gate_results.len(), 3 * count);
    for result in gate_results {
        let result: Value = serde_json::from_str(&result)?;
        assert_eq!(result["error"]["code"], "steward_plan_review_required");
        assert_eq!(result["error"]["recoverable"], true);
    }
    let approvals: i64 = db.query_row("SELECT count(*) FROM btcc_guided_tool_calls WHERE json_extract(result_json,'$.authority_pending')=1", [], |row| row.get(0))?;
    assert_eq!(approvals, 0);
    let packet: String = db.query_row(
        "SELECT packet_json FROM btcc_subsession_delegations ORDER BY rowid DESC LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    let packet: Value = serde_json::from_str(&packet)?;
    assert_eq!(packet["acceptance_criteria"], json!(["Evidence verified"]));
    assert!(
        packet["parent_work_ref"]
            .get("review_revision_id")
            .is_none()
    );
    Ok(())
}
