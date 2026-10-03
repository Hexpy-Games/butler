use super::{instruction_sequences::calls, routing::tool_response, work_model::*};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Scenario};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) fn cassette(cassette: &mut Cassette) {
    let base = cassette.exchanges[0].clone();
    for depth in 1..=3 {
        let label = format!("Issue controls at depth {depth}");
        let mut first = base.clone();
        first.request.key.user_request = label.clone();
        let common = json!({"target_session_id":format!("{{{{TARGET_{depth}}}}}"),"relation_id":format!("{{{{RELATION_{depth}}}}}"),"relation_epoch":1,"expected_control_epoch":1});
        let mut queue = common.clone();
        queue["idempotency_key"] = json!(format!("parent-queue-{depth}"));
        queue["mode"] = json!("queue");
        queue["instruction"] = json!({"text":format!("After the assigned Task, inspect the retained result at depth {depth}")});
        let mut steer = common;
        steer["idempotency_key"] = json!(format!("parent-steer-{depth}"));
        steer["mode"] = json!("steer");
        steer["instruction"] =
            json!({"text":format!("Answer the control question at depth {depth}")});
        first.response = calls(&[("session_control", queue), ("session_control", steer)]);
        let mut last = base.clone();
        last.request.key.user_request = label;
        last.request.key.round = [
            "function_call",
            "function_call",
            "function_call_output",
            "function_call_output",
        ]
        .map(str::to_owned)
        .to_vec();
        let mut answer = base.clone();
        answer.request.key.user_request = format!("Answer the control question at depth {depth}");
        cassette.exchanges.extend([first, last, answer]);
    }
    for label in [
        "Old parent after transfer",
        "New parent with stale epoch",
        "New parent after transfer",
    ] {
        let mut first = base.clone();
        first.request.key.user_request = label.into();
        first.response = tool_response(
            "session_control",
            &json!({"target_session_id":"{{TARGET_3}}","relation_id":"{{RELATION_3}}","relation_epoch":if label=="New parent after transfer" {2} else {1},"expected_control_epoch":0,"idempotency_key":label,"mode":"steer","instruction":{"text":"Answer the transferred parent question"}}),
        );
        for chunk in &mut first.response.chunks {
            chunk.text = chunk.text.replace(
                "\\\"expected_control_epoch\\\":0",
                "\\\"expected_control_epoch\\\":{{TRANSFER_EPOCH}}",
            );
        }
        let mut last = base.clone();
        last.request.key.user_request = label.into();
        last.request.key.round = ["function_call", "function_call_output"]
            .map(str::to_owned)
            .to_vec();
        cassette.exchanges.extend([first, last]);
    }
    let mut answer = base;
    answer.request.key.user_request = "Answer the transferred parent question".into();
    answer.request.key.round = vec!["user".into()];
    cassette.exchanges.push(answer);
}

pub(super) async fn user(
    s: &Scenario,
    session: &str,
    key: &str,
    body: Value,
    epoch: Option<u64>,
) -> Result<Value, HarnessError> {
    let response = s.gw.post(&format!("/sessions/{session}/instructions"), json!({"idempotency_key":key,"mode":"steer","expected_control_epoch":epoch,"instruction":body})).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    Ok(response.data().clone())
}

pub(super) async fn receipts(s: &Scenario, child: &str) -> Result<Value, HarnessError> {
    let response = s.gw.get(&format!("/sessions/{child}/instructions")).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    Ok(response.data().clone())
}

pub(super) async fn applied(s: &Scenario, child: &str, key: &str) -> Result<Value, HarnessError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let view = receipts(s, child).await?;
        if let Some(receipt) = view["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["idempotency_key"] == key && r["status"] == "applied")
        {
            settled(s).await?;
            return Ok(receipt.clone());
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Instruction did not apply: {key}: {view}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) async fn run(
    s: &Scenario,
    db: &rusqlite::Connection,
    relations: &[(String, String, String, String)],
    original: &Value,
) -> Result<(), HarnessError> {
    settled(s).await?;
    let mut chain = Vec::new();
    let mut parent = "butler/app-general".to_owned();
    for depth in 1..=3 {
        let relation = relations.iter().find(|r| r.0 == parent).unwrap();
        let id: String = db
            .query_row(
                "SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1",
                [&relation.1],
                |r| r.get(0),
            )
            .unwrap();
        s.provider()?
            .add_placeholder(&format!("TARGET_{depth}"), &relation.1);
        s.provider()?
            .add_placeholder(&format!("RELATION_{depth}"), id);
        chain.push(relation.clone());
        parent = relation.1.clone();
    }
    for (i, relation) in chain.iter().enumerate() {
        let depth = i + 1;
        let label = format!("Issue controls at depth {depth}");
        if i == 0 {
            steer_turn(s, &label).await?;
        } else {
            user(
                s,
                &relation.0,
                &format!("owner-control-{depth}"),
                json!({"text":label}),
                None,
            )
            .await?;
        }
        let receipt = applied(s, &relation.1, &format!("parent-steer-{depth}")).await?;
        assert_eq!(receipt["sender"]["session_id"], relation.0);
        let queued = receipts(s, &relation.1).await?;
        let queue = queued["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["idempotency_key"] == format!("parent-queue-{depth}"))
            .unwrap();
        assert_eq!(queue["status"], "waiting_for_task");
        assert_eq!(queue["mode"], "queue");
        assert_eq!(queue["anchor"]["task_id"], original["tasks"][0]["id"]);
    }
    settled(s).await?;
    scoped_edits(s, &chain[2].1, original).await?;
    super::conflicts::run(s, &chain[2].0, &chain[2].1).await?;
    transfer(s, &chain).await?;
    let latest = summary(s).await?;
    assert_eq!(latest["plan_id"], original["plan_id"]);
    assert_eq!(latest["root_spec_ref"], original["root_spec_ref"]);
    assert_eq!(latest["tasks"][0]["status"], "awaiting_review");
    assert_eq!(latest["tasks"][0]["evidence_refs"], json!(["test:leaf"]));
    Ok(())
}

async fn scoped_edits(s: &Scenario, child: &str, original: &Value) -> Result<(), HarnessError> {
    let task = &original["tasks"][0];
    let graph = summary(s).await?["graph_revision"].as_u64().unwrap();
    let add = json!({"op":"add","work_id":task["work_id"],"spec_ref":task["spec_ref"],"task":{"key":"owned-follow-up","description":"Check retained result","part_ids":task["part_ids"],"criterion_ids":task["criterion_ids"],"after":[task["id"]]}});
    let first = user(s, child, "child-add", json!({"operations":[add],"expected_graph_revision":graph,"reason":"Assigned Work follow-up"}), None).await?;
    assert_eq!(first["status"], "applied", "{first}");
    let id = first["result"]["operations"][0]["task"]["id"].clone();
    let outside = user(s, child, "outside-edit", json!({"operations":[{"op":"edit","task_id":original["tasks"][1]["id"],"expected_revision":1,"description":"Illegal sibling change"}],"expected_graph_revision":graph+1,"reason":"Attempt outside assignment"}), None).await?;
    assert_eq!(outside["error"]["code"], "task_mutation_scope_invalid");
    let edited = user(s, child, "child-edit", json!({"operations":[{"op":"edit","task_id":id,"expected_revision":1,"description":"Retained evidence check"},{"op":"reorder","task_ids":[id]},{"op":"dependencies","add":[],"remove":[{"from":task["id"],"to":id}]},{"op":"remove","task_id":id,"expected_revision":3,"remove_edges":[]}],"expected_graph_revision":graph+1,"reason":"Ordered local graph edits"}), None).await?;
    assert_eq!(edited["status"], "applied", "{edited}");
    assert_eq!(edited["operation_ids"].as_array().unwrap().len(), 4);
    Ok(())
}

async fn transfer(
    s: &Scenario,
    chain: &[(String, String, String, String)],
) -> Result<(), HarnessError> {
    let child = &chain[2].1;
    let view = receipts(s, child).await?;
    let relation = view["instructions"][0]["relation"]["relation_id"].clone();
    let body = json!({"transfer_parent":{"relation_id":relation,"expected_relation_epoch":1,"parent_session_id":chain[0].1,"parent_turn_id":chain[0].2,"reason":"Owner transfers direct ownership to ancestor"}});
    let receipt = user(
        s,
        child,
        "transfer",
        body.clone(),
        view["control_epoch"].as_u64(),
    )
    .await?;
    assert_eq!(receipt["status"], "applied", "{receipt}");
    assert_eq!(receipt["result"]["relation_epoch"], 2);
    assert_eq!(
        user(s, child, "transfer", body, view["control_epoch"].as_u64()).await?,
        receipt
    );
    let epoch = receipt["result"]["control_epoch"].as_u64().unwrap();
    s.provider()?
        .add_placeholder("TRANSFER_EPOCH", epoch.to_string());
    for (parent, label, error) in [
        (
            &chain[1].1,
            "Old parent after transfer",
            Some("parent_conflict"),
        ),
        (
            &chain[0].1,
            "New parent with stale epoch",
            Some("relation_epoch_conflict"),
        ),
        (&chain[0].1, "New parent after transfer", None),
    ] {
        let owner = user(s, parent, label, json!({"text":label}), None).await?;
        applied(s, parent, label).await?;
        if let Some(error) = error {
            let requests = s.provider()?.requests();
            assert!(
                requests.iter().any(|r| r.to_string().contains(error)),
                "{owner}: missing {error}"
            );
        } else {
            applied(s, child, label).await?;
        }
    }
    Ok(())
}

async fn settled(s: &Scenario) -> Result<(), HarnessError> {
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let active: u64 = db.query_row("SELECT count(*) FROM btcc_turns WHERE semantic_state='admitted' AND suspension_reason IS NULL",[],|r|r.get(0)).unwrap();
        let pending: u64 = db
            .query_row(
                "SELECT count(*) FROM btcc_subsession_outbox WHERE status='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let files =
            std::fs::read_dir(s.sandbox.data.join("runtime/inbound-events/pending"))?.count();
        let processing =
            std::fs::read_dir(s.sandbox.data.join("runtime/inbound-events/processing"))?.count();
        if active == 0 && pending == 0 && files == 0 && processing == 0 {
            return Ok(());
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Native result routing did not settle: {active}/{pending}/{files}/{processing}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
