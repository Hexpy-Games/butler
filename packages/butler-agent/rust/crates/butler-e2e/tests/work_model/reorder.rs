use super::{
    instruction_sequences::{calls, instruct},
    work_model::*,
};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::{Duration, Instant};

pub(super) async fn run() -> Result<(), HarnessError> {
    let label = "Apply a revisioned pending Task order";
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let mut stale = base.clone();
    stale.request.key.user_request = label.into();
    stale.response = calls(&[(
        "work_apply",
        json!({"expected_graph_revision":1,"command":{"op":"start","task_id":"{{B}}","expected_revision":1}}),
    )]);
    let mut answer = base;
    answer.request.key.user_request = label.into();
    answer.request.key.round = ["function_call", "function_call_output", "user"]
        .map(str::to_owned)
        .to_vec();
    cassette.exchanges.extend([stale, answer]);
    let s = Setup::new("WM-03-REORDER")?
        .env("BUTLER_WORK_MODEL", "core")
        .env("BUTLER_E2E_INSTRUCTION_BOUNDARY", "response")
        .env("BUTLER_E2E_INSTRUCTION_MESSAGE", label)
        .stub_cassette(cassette)
        .start()
        .await?;
    let (instruction, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(apply(&s, light(&instruction)).await?["ok"], true);
    let view = summary(&s).await?;
    let a = view["tasks"][0]["id"].clone();
    let b = view["tasks"][1]["id"].clone();
    let c = view["tasks"][2]["id"].clone();
    s.provider()?.add_placeholder("B", b.as_str().unwrap());
    assert_eq!(apply(&s,json!({"instruction_id":instruction,"idempotency_key":"start-a","expected_graph_revision":1,"command":{"op":"start","task_id":a,"expected_revision":1}})).await?["ok"],true);
    let before = summary(&s).await?;
    let accepted =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":label,"mode":"steer"}),
        )
        .await?;
    let turn = accepted_turn_id(accepted.data())?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !s.sandbox.data.join("e2e-instruction-held").exists() {
        assert!(
            Instant::now() < deadline,
            "Provider response did not reach barrier"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let receipt = instruct(&s,"rank-edit","steer",json!({"expected_graph_revision":1,"reason":"C precedes B while A continues","operations":[{"op":"reorder","task_ids":[c,b]},{"op":"dependencies","add":[{"from":c,"to":b}],"remove":[{"from":b,"to":c}]}]})).await?;
    assert_eq!(receipt["status"], "pending_safe_point");
    tokio::fs::write(s.sandbox.data.join("e2e-instruction-release"), b"release").await?;
    assert_eq!(
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?["state"],
        "delivered"
    );
    let after = summary(&s).await?;
    assert_eq!(after["tasks"][0], before["tasks"][0], "Steer changed A");
    assert_eq!(after["tasks"][1]["id"], c);
    assert_eq!(after["tasks"][2]["id"], b);
    assert_eq!(after["counts"]["running"], 1);
    assert_eq!(after["counts"]["pending"], 2);
    assert_eq!(after["graph_revision"], 3);
    let graph = s.gw.get("/sessions/general/task-graph").await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    assert!(
        graph.data()["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["from"] == c && edge["to"] == b)
    );
    let receipts = s.gw.get("/sessions/general/instructions").await?;
    assert_eq!(receipts.data()["instructions"][2]["status"], "applied");
    assert_eq!(
        receipts.data()["instructions"][2]["operation_ids"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(s.provider()?.served(), 3);
    s.finish().await
}
