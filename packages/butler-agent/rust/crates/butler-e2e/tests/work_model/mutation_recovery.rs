use super::{boundaries::held, routing::tool_response, work_model::*};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

pub(super) async fn run(completion: bool) -> Result<(), HarnessError> {
    let label = "Crash after the atomic Task edit";
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let mut edit = base.clone();
    edit.request.key.user_request = label.into();
    let operations = if completion {
        super::instruction_sequences::finish(&json!("{{A}}"), 2)
    } else {
        vec![
            json!({"op":"edit","task_id":"{{B}}","expected_revision":1,"description":"Persist this exact edit once"}),
        ]
    };
    edit.response = tool_response(
        "work_apply",
        &json!({"expected_control_epoch":1,"expected_graph_revision":1,"reason":"Retain the atomic mutation","operations":operations}),
    );
    let mut answer = base;
    answer.request.key.user_request = label.into();
    answer.request.key.round = vec!["user".into()];
    cassette.exchanges.extend([edit, answer]);
    let mut s = Setup::new("WM-10-MUTATION")?
        .env("BUTLER_WORK_MODEL", "core")
        .env("BUTLER_E2E_INSTRUCTION_BOUNDARY", "tool_result")
        .env("BUTLER_E2E_INSTRUCTION_MESSAGE", label)
        .stub_cassette(cassette)
        .start()
        .await?;
    let (original, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(apply(&s, light(&original)).await?["ok"], true);
    let view = summary(&s).await?;
    if completion {
        assert_eq!(apply(&s,json!({"instruction_id":original,"idempotency_key":"start","expected_graph_revision":1,"command":{"op":"start","task_id":view["tasks"][0]["id"],"expected_revision":1}})).await?["ok"],true);
        s.provider()?
            .add_placeholder("A", view["tasks"][0]["id"].as_str().unwrap());
    }
    s.provider()?
        .add_placeholder("B", view["tasks"][1]["id"].as_str().unwrap());
    let accepted =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","text":label,"mode":"steer"}),
        )
        .await?;
    let turn = accepted_turn_id(accepted.data())?;
    held(&s).await?;
    let before = summary(&s).await?;
    if completion {
        assert_eq!(before["tasks"][0]["status"], "completed");
        assert_eq!(
            before["tasks"][0]["evidence_refs"],
            json!(["test:retained"])
        );
        assert_eq!(before["tasks"][1]["status"], "pending");
    } else {
        assert_eq!(
            before["tasks"][1]["description"],
            "Persist this exact edit once"
        );
        assert_eq!(before["tasks"][1]["revision"], 2);
    }
    assert_eq!(before["graph_revision"], if completion { 1 } else { 2 });
    let receipts =
        s.gw.get("/sessions/general/instructions")
            .await?
            .data()
            .clone();
    assert_eq!(receipts["instructions"][1]["status"], "applied");
    assert_eq!(
        receipts["instructions"][1]["operation_ids"]
            .as_array()
            .unwrap()
            .len(),
        if completion { 3 } else { 1 }
    );
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let mutations: u64 = db
        .query_row(
            "SELECT count(*) FROM wm_audit WHERE json_extract(request_json,'$.command.op')='batch'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mutations, 1);
    s.crash_and_restart().await?;
    assert_eq!(summary(&s).await?, before);
    assert_eq!(
        s.gw.get("/sessions/general/instructions").await?.data(),
        &receipts
    );
    let retry =
        s.gw.post(&format!("/turns/{turn}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    assert_eq!(
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?["state"],
        "delivered",
        "provider misses: {:?}",
        s.provider()?.misses()
    );
    assert_eq!(
        summary(&s).await?,
        before,
        "Resume repeated a committed graph mutation"
    );
    assert_eq!(
        s.gw.get("/sessions/general/instructions").await?.data(),
        &receipts
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM wm_audit WHERE json_extract(request_json,'$.command.op')='batch'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        mutations
    );
    assert_eq!(s.provider()?.served(), 3);
    s.finish().await
}
