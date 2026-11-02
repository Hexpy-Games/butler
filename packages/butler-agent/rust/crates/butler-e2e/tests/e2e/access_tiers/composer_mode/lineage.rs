//! Real delegation proves existing and future children share only their run's revision.
use super::*;
use std::time::{Duration, Instant};

fn plan() -> Value {
    call(
        "plan",
        "replace_work_plan",
        &json!({"objective":"Check evidence","execution_mode":"workers",
        "actions":[{"action_key":"first","description":"Check first source","dependency_keys":[]},
        {"action_key":"future","description":"Check later source","dependency_keys":[]}],"checks":["Both checked"]}),
    )
}
fn delegate(id: &str) -> Value {
    call(
        id,
        "delegate_to_worker",
        &json!({"action_key":id,"objective":format!("Check {id} source"),
        "acceptance_criteria":["Checked"],"implementation_brief":"Run both status checks","safe_title":id}),
    )
}
fn disposition(actions: &Value) -> Value {
    call(
        "done",
        "record_work_disposition",
        &json!({"work_id":"{{WORK}}","disposition":"completed",
        "summary":"Checked","action_updates":actions,"remaining_actions":[],"followups":[]}),
    )
}
fn configure(script: &Script) {
    let mut rounds = script.rounds.lock().unwrap();
    rounds.insert(PROMPT.into(),vec![call("handoff","delegate_to_steward",
        &json!({"request":"Check evidence","checks":["Both checked"],"safe_title":"Check evidence"}))]);
    rounds.insert(
        "role: steward".into(),
        vec![
            plan(),
            call(
                "review",
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            ),
            delegate("first"),
            command("parent-first"),
            command("parent-second"),
            delegate("future"),
            call("wait", "wait_for_worker", &json!({})),
            disposition(&json!([
            {"action_key":"first","status":"done"},{"action_key":"future","status":"done"}])),
        ],
    );
    rounds.insert(
        "role: worker".into(),
        vec![
            call(
                "worker-plan",
                "replace_work_plan",
                &json!({
        "objective":"Check status","execution_mode":"direct","actions":[{"action_key":"check",
        "description":"Check status","dependency_keys":[]}],"checks":["Checked"]}),
            ),
            call(
                "worker-review",
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            ),
            command("child-first"),
            command("child-second"),
            disposition(&json!([{"action_key":"check","status":"done"}])),
            json!({"type":"message","id":"worker-done","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":"Worker checks completed.","annotations":[]}]}),
        ],
    );
}

fn result_script(s: &Scenario, script: &Script, cards: &[Value]) -> Result<(), HarnessError> {
    let parent = cards
        .iter()
        .find(|card| card["approval"]["operation"]["command"] == "echo parent-first")
        .unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let work: String = db.query_row(
        "SELECT work_id FROM btcc_guided_works WHERE origin_turn_id=?1",
        [parent["source_turn_id"].as_str().unwrap()],
        |row| row.get(0),
    )?;
    script.rounds.lock().unwrap().insert(
        "Delegated result status: success summary: Worker checks completed. evidence_refs:".into(),
        vec![
            call("result-wait", "wait_for_worker", &json!({})),
            call(
                "result-done",
                "record_work_disposition",
                &json!({"work_id":work,"disposition":"completed",
                "summary":"Checked","action_updates":[{"action_key":"first","status":"done"},
                {"action_key":"future","status":"done"}],"remaining_actions":[],"followups":[]}),
            ),
        ],
    );
    Ok(())
}

#[tokio::test]
async fn existing_and_future_workers_and_parent_use_the_answered_revision()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server) = setup().await?;
    configure(&script);
    let root = s.gw.say_turn("general", PROMPT).await?;
    let cards = pending(&s, 2).await?;
    assert!(
        cards
            .iter()
            .any(|c| c["approval"]["operation"]["command"] == "echo child-first")
    );
    assert!(
        cards
            .iter()
            .any(|c| c["approval"]["operation"]["command"] == "echo parent-first")
    );
    result_script(&s, &script, &cards)?;
    controls(&s, "full_access").await?;
    s.restart().await?;
    for card in &cards {
        answer(&s, card["request_ref"].as_str().unwrap(), "allow").await?;
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let finished: u64 = db.query_row(
            "SELECT count(*) FROM btcc_steward_results WHERE status='success'",
            [],
            |row| row.get(0),
        )?;
        drop(db);
        if finished >= 3 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "lineage unfinished: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    assert_revision(&s, &root, "full_access", 1)?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: u64 = db.query_row("SELECT count(*) FROM btcc_authority_requests", [], |row| {
        row.get(0)
    })?;
    assert_eq!(
        count, 2,
        "parent/existing/future child commands create no further approval"
    );
    let executed: u64 = db.query_row("SELECT count(*) FROM btcc_guided_tool_calls WHERE tool_name='run_command' AND status='completed' AND json_extract(result_json,'$.ok')=1", [], |row| row.get(0))?;
    assert_eq!(
        executed, 6,
        "all parent/existing/future child commands actually succeed"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
