use super::{recursive, routing::tool_response, work_model::*};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::{Duration, Instant};

pub(super) async fn held(s: &Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !s.sandbox.data.join("e2e-instruction-held").exists() {
        assert!(
            Instant::now() < deadline,
            "Final/wait boundary was not reached"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

pub(super) async fn answer() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let label = "Check the last inbox before accepting an answer";
    let mut first = base.clone();
    first.request.key.user_request = label.into();
    let mut latest = first.clone();
    latest.request.key.round = ["message", "user"].map(str::to_owned).to_vec();
    cassette.exchanges.extend([first, latest]);
    let mut s = Setup::new("WM-06-FINAL")?
        .env("BUTLER_WORK_MODEL", "core")
        .env("BUTLER_E2E_INSTRUCTION_BOUNDARY", "answer")
        .stub_cassette(cassette)
        .start()
        .await?;
    let accepted = s.gw.say("general", label).await?;
    let turn = accepted_turn_id(&accepted)?;
    held(&s).await?;
    let queued = s.gw.post("/sessions/general/instructions",json!({"idempotency_key":"after-answer","mode":"queue","instruction":{"text":"Reply with exactly the word: once"}})).await?;
    assert_eq!(queued.status, 200, "{}", queued.text);
    assert_eq!(queued.data()["status"], "waiting_for_turn");
    assert_eq!(queued.data()["anchor"]["turn_id"], turn);
    assert!(queued.data().get("draft_task_id").is_none());
    s.gw.patch("/settings", json!({"follow_up_behavior":"steer"}))
        .await?;
    let steer =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":"Include the last instruction in this answer"}),
        )
        .await?;
    assert_eq!(steer.status, 202, "{}", steer.text);
    tokio::fs::write(s.sandbox.data.join("e2e-instruction-release"), b"release").await?;
    let result =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(result["state"], "delivered", "{result}");
    let deadline = Instant::now() + Duration::from_secs(15);
    let before = loop {
        let view = s.gw.get("/sessions/general/instructions").await?;
        let receipts = view.data()["instructions"].as_array().unwrap();
        if receipts.len() == 3 && receipts.iter().all(|r| r["status"] == "applied") {
            break view.data().clone();
        }
        assert!(
            Instant::now() < deadline,
            "Tier 0 queue stranded: {}",
            view.text
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(before["instructions"][1]["mode"], "queue");
    assert_eq!(s.gw.turns("general").await?.len(), 2);
    assert_eq!(summary(&s).await?["total"], 0);
    assert_eq!(s.provider()?.served(), 3);
    s.restart().await?;
    assert_eq!(
        s.gw.get("/sessions/general/instructions").await?.data(),
        &before
    );
    assert_eq!(
        s.provider()?.served(),
        3,
        "Restart repeated a committed question"
    );
    s.finish().await
}

pub(super) async fn wait() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let label = "Delegate and check the inbox before waiting";
    let mut first = base.clone();
    first.request.key.user_request = label.into();
    first.response = tool_response(
        "delegate_to_steward",
        &json!({"request":"Execute the Task"}),
    );
    let mut latest = base.clone();
    latest.request.key.user_request = label.into();
    latest.request.key.round = ["function_call", "function_call_output", "user"]
        .map(str::to_owned)
        .to_vec();
    let mut child = base.clone();
    child.request.key.user_request = "{{CHILD}}".into();
    child.response = tool_response(
        "work_apply",
        &json!({"expected_graph_revision":1,"command":{"op":"start","task_id":"{{TASK}}","expected_revision":3}}),
    );
    let mut child_end = base;
    child_end.request.key.user_request = "{{CHILD}}".into();
    child_end.request.key.round = ["function_call", "function_call_output"]
        .map(str::to_owned)
        .to_vec();
    cassette.exchanges.extend([first, latest, child, child_end]);
    let s = Setup::new("WM-06-WAIT")?
        .env("BUTLER_WORK_MODEL", "core")
        .env("BUTLER_E2E_INSTRUCTION_BOUNDARY", "wait")
        .stub_cassette(cassette)
        .start()
        .await?;
    let (instruction, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(apply(&s,json!({"instruction_id":instruction,"idempotency_key":"create","command":{"op":"create","bundle":recursive::bundle(3)}})).await?["ok"],true);
    let view = summary(&s).await?;
    let task = &view["tasks"][0];
    let id = task["id"].as_str().unwrap();
    let work = task["work_id"].as_str().unwrap();
    let spec = s.gw.get("/sessions/general/work-spec?node_id=goal").await?;
    s.provider()?.add_placeholder("CHILD",format!("Execute assigned canonical Task {id} in Work {work} (source revision 2). Start it, read exact Spec/ancestors, submit results and evidence, then report to your parent for criterion review. Do not create a root Work or complete your own delegated Task.\n{}",spec.data()));
    s.provider()?.add_placeholder("TASK", id);
    assert_eq!(apply(&s,json!({"instruction_id":instruction,"idempotency_key":"start","expected_graph_revision":1,"command":{"op":"start","task_id":id,"expected_revision":1}})).await?["ok"],true);
    let accepted =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":label,"mode":"steer"}),
        )
        .await?;
    let turn = accepted_turn_id(accepted.data())?;
    held(&s).await?;
    let steer = s.gw.post("/messages",json!({"chat_id":"general","text":"Answer the newest question before waiting","mode":"steer"})).await?;
    assert_eq!(steer.status, 202, "{}", steer.text);
    tokio::fs::write(s.sandbox.data.join("e2e-instruction-release"), b"release").await?;
    let result =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(result["state"], "delivered", "{result}");
    let receipts = s.gw.get("/sessions/general/instructions").await?;
    assert_eq!(receipts.data()["instructions"][2]["status"], "applied");
    assert_eq!(
        receipts.data()["instructions"][2]["delivered_turn_id"],
        turn
    );
    assert_eq!(summary(&s).await?["plan_id"], view["plan_id"]);
    assert!(s.provider()?.requests().iter().any(|r| {
        r.to_string()
            .contains("Answer the newest question before waiting")
    }));
    s.finish().await
}
