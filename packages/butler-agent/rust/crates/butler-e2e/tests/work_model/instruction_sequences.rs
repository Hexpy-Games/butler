use super::{routing::tool_response, work_model::*};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    scenario::{Scenario, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(super) fn calls(calls: &[(&str, Value)]) -> ResponseRecord {
    let items = calls.iter().enumerate().map(|(i,(name,args))|json!({"type":"function_call","id":format!("fc_{i}"),"call_id":format!("call_{i}"),"name":name,"arguments":args.to_string(),"status":"completed"})).collect::<Vec<_>>();
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_control","status":"in_progress","output":[]}}),
    ];
    for (i, item) in items.iter().enumerate() {
        events.extend([json!({"type":"response.output_item.added","output_index":i,"item":item}),json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":i,"arguments":item["arguments"]}),json!({"type":"response.output_item.done","output_index":i,"item":item})]);
    }
    events.push(json!({"type":"response.completed","response":{"id":"resp_control","status":"completed","model":"gpt-6-luna","output":items,"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut event)| {
                event["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    ),
                }
            })
            .collect(),
    }
}

pub(super) fn finish(task: &Value, rev: u64) -> Vec<Value> {
    vec![
        json!({"op":"submit","task_id":task,"expected_revision":rev,"result_refs":["artifact:sorted"],"evidence_refs":["test:retained"]}),
        json!({"op":"review","task_id":task,"expected_revision":rev+1,"result_revision":1,"criterion_results":[{"criterion_id":"AC-SORT","verdict":"pass","evidence_refs":["test:retained"],"reason":"Every document retained"}]}),
        json!({"op":"complete","task_id":task,"expected_revision":rev+2}),
    ]
}

pub(super) async fn instruct(
    s: &Scenario,
    key: &str,
    mode: &str,
    body: Value,
) -> Result<Value, HarnessError> {
    let response =
        s.gw.post(
            "/sessions/general/instructions",
            json!({"idempotency_key":key,"mode":mode,"instruction":body}),
        )
        .await?;
    assert_eq!(response.status, 200, "{}", response.text);
    Ok(response.data().clone())
}

pub(super) async fn same_turn_boundary() -> Result<(), HarnessError> {
    same_turn(false).await
}

pub(super) async fn same_turn(question: bool) -> Result<(), HarnessError> {
    draft_resolution(question, false).await
}

pub(super) async fn unavailable_escalation() -> Result<(), HarnessError> {
    draft_resolution(false, true).await
}

async fn draft_resolution(question: bool, unavailable: bool) -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let label = "Finish the current Task and honour its boundary queue";
    let mut first = base.clone();
    first.request.key.user_request = label.into();
    first.response = calls(&[
        (
            "work_apply",
            json!({"expected_graph_revision":2,"operations":finish(&json!("{{A}}"),2),"expected_control_epoch":1,"reason":"Finish current Task"}),
        ),
        (
            "work_apply",
            json!({"expected_graph_revision":2,"command":{"op":"start","task_id":"{{B}}","expected_revision":1}}),
        ),
    ]);
    let mut resolve = base.clone();
    resolve.request.key.user_request = label.into();
    resolve.request.key.round = [
        "function_call",
        "function_call",
        "function_call_output",
        "function_call_output",
        "user",
    ]
    .map(str::to_owned)
    .to_vec();
    resolve.response = tool_response(
        "work_apply",
        &json!({"instruction_id":"{{QUEUE}}","expected_graph_revision":2,"expected_control_epoch":1,"reason":"Resolve the queued draft using the same brief","operations":[{"op":"resolve_draft","task_id":"{{X}}","expected_revision":1,"criterion_ids":["AC-SORT"]},{"op":"start","task_id":"{{X}}","expected_revision":2}]}),
    );
    if question {
        resolve.response = tool_response(
            "work_apply",
            &json!({"instruction_id":"{{QUEUE}}","expected_graph_revision":2,"expected_control_epoch":1,"reason":"This queued input asks a question","operations":[{"op":"resolve_draft","task_id":"{{X}}","expected_revision":1,"criterion_ids":[],"question":true}]}),
        );
    } else if unavailable {
        resolve.response = calls(&[
            (
                "work_apply",
                json!({"instruction_id":"{{QUEUE}}","expected_graph_revision":2,"expected_control_epoch":1,"reason":"This request needs a new Spec criterion","operations":[{"op":"resolve_draft","task_id":"{{X}}","expected_revision":1,"criterion_ids":["AC-UNAVAILABLE"]}]}),
            ),
            (
                "work_apply",
                json!({"expected_graph_revision":2,"command":{"op":"start","task_id":"{{B}}","expected_revision":1}}),
            ),
        ]);
    }
    let mut last = base.clone();
    last.request.key.user_request = label.into();
    last.request.key.round = resolve.request.key.round.clone();
    last.request.key.round.extend(if unavailable {
        vec![
            "function_call".into(),
            "function_call".into(),
            "function_call_output".into(),
            "function_call_output".into(),
        ]
    } else {
        vec!["function_call".into(), "function_call_output".into()]
    });
    cassette.exchanges.extend([first, resolve, last]);
    let s = Setup::new("WM-02-SAME-TURN")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    let (turn, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(apply(&s, light(&turn)).await?["ok"], true);
    let original = summary(&s).await?;
    let a = original["tasks"][0]["id"].clone();
    let b = original["tasks"][1]["id"].clone();
    assert_eq!(apply(&s,json!({"instruction_id":turn,"idempotency_key":"start","expected_graph_revision":1,"command":{"op":"start","task_id":a,"expected_revision":1}})).await?["ok"],true);
    let queued = instruct(
        &s,
        "after-task",
        "queue",
        json!({"text":if question {"After A, how many documents remain?"} else {"After A sort the remaining documents"}}),
    )
    .await?;
    assert_eq!(queued["status"], "waiting_for_task");
    for (name, value) in [
        ("A", a.as_str().unwrap()),
        ("B", b.as_str().unwrap()),
        ("X", queued["draft_task_id"].as_str().unwrap()),
        ("QUEUE", queued["instruction_id"].as_str().unwrap()),
    ] {
        s.provider()?.add_placeholder(name, value);
    }
    let (active, result) = steer_turn(&s, label).await?;
    assert_eq!(result["state"], "delivered", "{result}");
    let view = summary(&s).await?;
    assert_eq!(view["total"], 4);
    assert_eq!(view["spec_count"], 1);
    assert_eq!(view["tasks"][0]["status"], "completed");
    assert_eq!(view["tasks"][1]["status"], "pending");
    if question {
        assert_eq!(view["tasks"][3]["status"], "cancelled");
        assert_eq!(view["tasks"][3]["criterion_ids"], json!([]));
        assert_eq!(view["current_task_id"], Value::Null);
    } else if unavailable {
        assert_eq!(view["tasks"][3]["status"], "draft");
        assert_eq!(view["tasks"][3]["criterion_ids"], json!([]));
        assert_eq!(view["current_task_id"], Value::Null);
    } else {
        assert_eq!(view["current_task_id"], queued["draft_task_id"]);
        assert_eq!(view["tasks"][3]["criterion_ids"], json!(["AC-SORT"]));
    }
    let receipts = s.gw.get("/sessions/general/instructions").await?;
    let receipt = receipts.data()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["instruction_id"] == queued["instruction_id"])
        .unwrap();
    assert_eq!(
        receipt["status"],
        if unavailable {
            "needs_input"
        } else {
            "applied"
        }
    );
    if unavailable {
        assert_eq!(receipt["error"]["code"], "in_use_spec_replan_unavailable");
        assert_eq!(
            apply(&s,json!({"instruction_id":active,"idempotency_key":"held-claim","expected_graph_revision":2,"command":{"op":"start","task_id":b,"expected_revision":1}})).await?["error"]["code"],
            "boundary_instructions_pending"
        );
    }
    assert_eq!(receipt["delivered_turn_id"], active);
    assert_eq!(s.gw.turns("general").await?.len(), 2);
    assert_eq!(s.provider()?.served(), 4);
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("instruction_response_fenced"))
    );
    s.finish().await
}

pub(super) async fn atomic_and_blocked() -> Result<(), HarnessError> {
    let (mut s, turn) = setup("WM-03-18-ATOMIC").await?;
    assert_eq!(apply(&s, light(&turn)).await?["ok"], true);
    let view = summary(&s).await?;
    let a = view["tasks"][0]["id"].clone();
    let b = view["tasks"][1]["id"].clone();
    assert_eq!(apply(&s,json!({"instruction_id":turn,"idempotency_key":"start","expected_graph_revision":1,"command":{"op":"start","task_id":a,"expected_revision":1}})).await?["ok"],true);
    let queued = instruct(
        &s,
        "held",
        "queue",
        json!({"text":"After A sort more documents"}),
    )
    .await?;
    let input = json!({"operations":[{"op":"block","task_id":a,"expected_revision":2,"reason":"Need an external fact"}],"expected_graph_revision":2,"reason":"Retain checkpoint"});
    let clock = Instant::now();
    let blocked = instruct(&s, "block", "steer", input.clone()).await?;
    eprintln!(
        "WM instruction admission+typed application {:?}",
        clock.elapsed()
    );
    assert_eq!(blocked["status"], "applied", "{blocked}");
    assert_eq!(s.provider()?.served(), 1);
    assert_eq!(instruct(&s, "block", "steer", input).await?, blocked);
    let state = summary(&s).await?;
    assert_eq!(state["tasks"][0]["status"], "blocked");
    assert_eq!(state["tasks"][0]["blocked_reason"], "Need an external fact");
    let stopped=instruct(&s,"typed-stop","queue",json!({"operations":[{"op":"session_stop"}],"expected_graph_revision":2,"reason":"Stop after captured Task"})).await?;
    assert_eq!(stopped["status"], "waiting_for_task");
    assert!(stopped.get("draft_task_id").is_none());
    assert_eq!(summary(&s).await?["total"], 4);
    let atomic = json!({"instruction_id":turn,"idempotency_key":"atomic","expected_graph_revision":2,"command":{"op":"batch","expected_control_epoch":1,"reason":"All or nothing","operations":[{"op":"edit","task_id":b,"expected_revision":1,"description":"Changed"},{"op":"start","task_id":b,"expected_revision":999}]}});
    assert_eq!(
        apply(&s, atomic).await?["error"]["code"],
        "task_revision_conflict"
    );
    assert_eq!(summary(&s).await?["tasks"], state["tasks"]);
    s.restart().await?;
    let receipts = s.gw.get("/sessions/general/instructions").await?;
    assert!(
        receipts.data()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["instruction_id"] == queued["instruction_id"]
                && r["mode"] == "queue"
                && r["anchor"]["task_id"] == a
                && r["status"] == "waiting_for_task")
    );
    s.finish().await
}

pub(super) async fn in_flight(setting: bool, tool: bool) -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let base = cassette.exchanges[0].clone();
    let mut first = base.clone();
    first.request.key.user_request = "Race the current answer".into();
    if tool {
        first.response =
            tool_response("write_file", &json!({"path":"stale.txt","content":"stale"}));
    }
    let mut last = base.clone();
    last.request.key.user_request = first.request.key.user_request.clone();
    last.request.key.round = if tool {
        ["function_call", "function_call_output", "user"]
            .map(str::to_owned)
            .to_vec()
    } else {
        vec!["message".into(), "user".into()]
    };
    for response in [&mut first.response, &mut last.response] {
        for chunk in &mut response.chunks {
            chunk.delay_ms = 0;
        }
    }
    first.response.chunks[0].delay_ms = 1000;
    cassette.exchanges = vec![first, last];
    let s = Setup::new("WM-05-INFLIGHT")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
        scale: 1.0,
        cap_ms: 1000,
        min_ms: 0,
    });
    if setting {
        assert_eq!(
            s.gw.patch("/settings", json!({"follow_up_behavior":"steer"}))
                .await?
                .status,
            200
        );
    }
    let accepted = s.gw.say("general", "Race the current answer").await?;
    let turn = accepted_turn_id(&accepted)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut input = json!({"chat_id":"general","text":"Use the newest instruction","client_message_id":"latest"});
    if !setting {
        input["mode"] = json!("steer");
    }
    let reply = s.gw.post("/messages", input).await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let received = s.gw.get("/sessions/general/instructions").await?;
    assert_eq!(received.data()["instructions"][1]["mode"], "steer");
    assert_eq!(
        received.data()["instructions"][1]["status"],
        "pending_safe_point"
    );
    let result =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(result["state"], "delivered", "{result}");
    assert_eq!(s.provider()?.served(), 2);
    assert!(!s.sandbox.data.join("stale.txt").exists());
    assert_eq!(summary(&s).await?["total"], 0);
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    let receipts = s.gw.get("/sessions/general/instructions").await?;
    assert_eq!(receipts.data()["instructions"][1]["status"], "applied");
    assert_eq!(
        receipts.data()["instructions"][1]["reply_ref"]["turn_id"],
        turn
    );
    s.finish().await
}
