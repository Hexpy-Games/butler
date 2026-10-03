use super::{recursive, routing::tool_response, work_model::*};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use butler_platform::sqlite;
use serde_json::json;
use std::time::Duration;

pub(super) async fn initial() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let template = cassette.exchanges[0].clone();
    let mut delegate = template.clone();
    delegate.request.key.user_request = "Delegate the assigned API verification".into();
    delegate.response = tool_response(
        "delegate_to_steward",
        &json!({"request":"Verify assigned API"}),
    );
    let mut parent_end = template.clone();
    parent_end.request.key.user_request = delegate.request.key.user_request.clone();
    parent_end.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    let mut child_start = template.clone();
    child_start.request.key.user_request = "{{CHILD_REQUEST}}".into();
    child_start.response = tool_response(
        "work_apply",
        &json!({"expected_graph_revision":1,"command":{"op":"start","task_id":"{{TASK}}","expected_revision":3}}),
    );
    let mut child_submit = template.clone();
    child_submit.request.key.user_request = child_start.request.key.user_request.clone();
    let mut child_denied = child_submit.clone();
    child_denied.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    child_denied.response = tool_response("delegate_to_worker", &json!({}));
    child_submit.request.key.round = vec![
        "function_call".into(),
        "function_call_output".into(),
        "function_call".into(),
        "function_call_output".into(),
    ];
    child_submit.response = tool_response(
        "work_apply",
        &json!({"expected_graph_revision":1,"command":{"op":"submit","task_id":"{{TASK}}","expected_revision":4,"result_refs":["artifact:api"],"evidence_refs":["test:api"]}}),
    );
    let mut child_end = template.clone();
    child_end.request.key.user_request = child_start.request.key.user_request.clone();
    child_end.request.key.round = vec![
        "function_call".into(),
        "function_call_output".into(),
        "function_call".into(),
        "function_call_output".into(),
        "function_call".into(),
        "function_call_output".into(),
    ];
    let mut returned = template.clone();
    returned.request.key.user_request =
        "Delegated result status: success summary: once evidence_refs: [\"test:api\"]".into();
    cassette.exchanges = vec![
        template,
        delegate,
        parent_end,
        child_start,
        child_denied,
        child_submit,
        child_end,
        returned,
    ];
    let s = Setup::new("WM-22-INITIAL")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    let (instruction, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    let created=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"initial-full","command":{"op":"create","bundle":recursive::bundle(3)}})).await?;
    assert_eq!(created["ok"], true, "{created}");
    let view = summary(&s).await?;
    let task = view["tasks"][0].clone();
    let id = task["id"].as_str().unwrap();
    let started=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"start-parent","expected_graph_revision":1,"command":{"op":"start","task_id":id,"expected_revision":1}})).await?;
    assert_eq!(started["ok"], true, "{started}");
    let spec = s.gw.get("/sessions/general/work-spec?node_id=goal").await?;
    assert_eq!(spec.status, 200);
    let child_request = format!(
        "Execute assigned canonical Task {id} in Work {} (source revision 2). Start it, read exact Spec/ancestors, submit results and evidence, then report to your parent for criterion review. Do not create a root Work or complete your own delegated Task.\n{}",
        task["work_id"].as_str().unwrap(),
        spec.data()
    );
    s.provider()?
        .add_placeholder("CHILD_REQUEST", child_request);
    s.provider()?.add_placeholder("TASK", id);
    steer_turn(&s, "Delegate the assigned API verification").await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let latest = loop {
        let v = summary(&s).await?;
        if v["tasks"][0]["status"] == "awaiting_review" {
            break v;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "child failed to submit {v}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(latest["tasks"][0]["id"], id);
    assert_eq!(latest["tasks"][0]["work_id"], task["work_id"]);
    assert_eq!(latest["total"], 3);
    assert_eq!(latest["spec_count"], 3);
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let child: String = db
        .query_row(
            "SELECT child_session_id FROM btcc_session_relations",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM btcc_session_relations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("nested_delegation_grant_required"))
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_works", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    let child_view = s.gw.get(&format!("/sessions/{child}/work-summary")).await?;
    assert_eq!(child_view.status, 200, "{}", child_view.text);
    assert_eq!(child_view.data()["plan_id"], latest["plan_id"]);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns.len() == 3 && turns.last().unwrap()["state"] == "delivered" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Child result waited for its own Task completion: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        summary(&s).await?["total"],
        3,
        "Child result created a queued draft"
    );
    let review=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"parent-review","expected_graph_revision":1,"command":{"op":"review","task_id":id,"expected_revision":5,"result_revision":1,"criterion_results":[{"criterion_id":"AC","verdict":"pass","evidence_refs":["test:api"],"reason":"API response verified"}]}})).await?;
    assert_eq!(review["ok"], true, "{review}");
    let completed=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"parent-complete","expected_graph_revision":1,"command":{"op":"complete","task_id":id,"expected_revision":6}})).await?;
    assert_eq!(completed["ok"], true, "{completed}");
    s.finish().await
}
