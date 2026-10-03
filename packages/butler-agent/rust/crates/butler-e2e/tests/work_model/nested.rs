use super::{recursive, routing::tool_response, work_model::*};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Exchange},
    scenario::Setup,
};
use butler_platform::sqlite;
use serde_json::{Value, json};
use std::time::Duration;

fn exchange(base: &Exchange, request: &str, round: usize, command: Option<Value>) -> Exchange {
    let mut e = base.clone();
    e.request.key.user_request = request.into();
    e.request.key.round = (0..round)
        .flat_map(|_| ["function_call".into(), "function_call_output".into()])
        .collect();
    if let Some(command) = command {
        let (name, args) = if command["op"] == "delegate" {
            ("delegate_to_worker", json!({}))
        } else {
            (
                "work_apply",
                json!({"expected_graph_revision":1,"command":command}),
            )
        };
        e.response = tool_response(name, &args);
    }
    e
}

pub(super) async fn chain() -> Result<(), HarnessError> {
    run(false).await
}

pub(super) async fn run(controls: bool) -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let mut first = base.clone();
    first.request.key.user_request = "Delegate the initial Task".into();
    first.response = tool_response(
        "delegate_to_steward",
        &json!({"request":"Execute the Task"}),
    );
    cassette.exchanges.push(first);
    cassette
        .exchanges
        .push(exchange(&base, "Delegate the initial Task", 1, None));
    for (depth, revision) in [(1, 3), (2, 5), (3, 7)] {
        let request = format!("{{{{CHILD_{depth}}}}}");
        cassette.exchanges.push(exchange(
            &base,
            &request,
            0,
            Some(json!({"op":"start","task_id":"{{TASK}}","expected_revision":revision})),
        ));
        let command = if depth < 3 {
            json!({"op":"delegate"})
        } else {
            json!({"op":"submit","task_id":"{{TASK}}","expected_revision":revision+1,"result_refs":["artifact:leaf"],"evidence_refs":["test:leaf"]})
        };
        cassette
            .exchanges
            .push(exchange(&base, &request, 1, Some(command)));
        cassette.exchanges.push(exchange(&base, &request, 2, None));
    }
    cassette.exchanges.push(exchange(
        &base,
        "Delegated result status: success summary: once evidence_refs: [\"test:leaf\"]",
        0,
        None,
    ));
    if controls {
        super::parent_sequences::cassette(&mut cassette);
        super::conflicts::cassette(&mut cassette);
    }
    let setup = Setup::new("WM-22-NESTED")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette);
    let setup = if controls {
        setup
            .env("BUTLER_E2E_INSTRUCTION_BOUNDARY", "response")
            .env("BUTLER_E2E_INSTRUCTION_MESSAGE", super::conflicts::HOLD)
    } else {
        setup
    };
    let s = setup.start().await?;
    let (instruction, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    let mut bundle = recursive::bundle(3);
    bundle["tasks"][0]["allow_nested_delegation"] = json!(true);
    assert_eq!(apply(&s,json!({"instruction_id":instruction,"idempotency_key":"create","command":{"op":"create","bundle":bundle}})).await?["ok"],true);
    let view = summary(&s).await?;
    let task = &view["tasks"][0];
    let id = task["id"].as_str().unwrap();
    let work = task["work_id"].as_str().unwrap();
    let spec = s.gw.get("/sessions/general/work-spec?node_id=goal").await?;
    for depth in 1..=3 {
        let source_revision = 2 * depth;
        s.provider()?.add_placeholder(&format!("CHILD_{depth}"),format!("Execute assigned canonical Task {id} in Work {work} (source revision {source_revision}). Start it, read exact Spec/ancestors, submit results and evidence, then report to your parent for criterion review. Do not create a root Work or complete your own delegated Task.\n{}",spec.data()));
    }
    s.provider()?.add_placeholder("TASK", id);
    assert_eq!(apply(&s,json!({"instruction_id":instruction,"idempotency_key":"start","expected_graph_revision":1,"command":{"op":"start","task_id":id,"expected_revision":1}})).await?["ok"],true);
    steer_turn(&s, "Delegate the initial Task").await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let latest = summary(&s).await?;
        if latest["tasks"][0]["status"] == "awaiting_review" {
            assert_eq!(latest["tasks"][0]["revision"], 9);
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Nested worker failed: {latest}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let mut stmt=db.prepare("SELECT r.parent_session_id,r.child_session_id,d.child_turn_id,d.packet_json FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) ORDER BY r.ordinal").unwrap();
    let relations = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(relations.len(), 3);
    let mut deepest = None;
    for (parent, child, turn, packet) in &relations {
        let packet: Value = serde_json::from_str(packet)?;
        assert_eq!(packet["task_id"], id);
        assert_eq!(packet["task_or_plan_refs"][1], work);
        let v = s.gw.get(&format!("/sessions/{child}/work-summary")).await?;
        assert_eq!(v.data()["plan_id"], view["plan_id"]);
        assert_eq!(v.data()["tier"], 2);
        if parent.starts_with("worker-") {
            deepest = Some((parent.clone(), turn.clone()));
        }
    }
    assert!(deepest.is_some(), "Worker did not receive its own worker");
    while db
        .query_row("SELECT count(*) FROM btcc_steward_results", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
        < 3
        || db
            .query_row(
                "SELECT count(*) FROM btcc_subsession_outbox WHERE status='delivered'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            < 3
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "Nested results did not reach all parents"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM btcc_subsession_outbox WHERE status='delivered'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        3
    );

    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_works", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM wm_attempts WHERE status='running'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    if controls {
        super::parent_sequences::run(&s, &db, &relations, &view).await?;
    }
    let graph_revision = summary(&s).await?["graph_revision"].clone();
    let result = json!({"criterion_id":"AC","verdict":"pass","evidence_refs":["test:leaf"],"reason":"Leaf result satisfies exact criterion"});
    let review=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"review","expected_graph_revision":graph_revision,"command":{"op":"review","task_id":id,"expected_revision":9,"result_revision":1,"criterion_results":[result]}})).await?;
    assert_eq!(review["ok"], true, "{review}");
    super::routing::report_prompt("Tier2 nested", &s.provider()?.requests());
    s.finish().await
}
