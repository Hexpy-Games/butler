use super::{
    boundaries::held,
    instruction_sequences::calls,
    parent_sequences::{applied, receipts, user},
    work_model::*,
};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Scenario};
use serde_json::json;

pub(super) const HOLD: &str = "Hold concurrent owner and parent edits";
const PARENT: &str = "Send revisioned edits to my direct child";
pub(super) fn cassette(cassette: &mut Cassette) {
    let base = cassette.exchanges[0].clone();
    let mut hold = base.clone();
    hold.request.key.user_request = HOLD.into();
    let mut final_answer = hold.clone();
    final_answer.request.key.round = ["message", "user", "user", "user"]
        .map(str::to_owned)
        .to_vec();
    let mut parent = base.clone();
    parent.request.key.user_request = PARENT.into();
    let first = json!({"target_session_id":"{{TARGET_3}}","relation_id":"{{RELATION_3}}","relation_epoch":1,"expected_control_epoch":null,"idempotency_key":"parent-conflict","mode":"steer","instruction":{"operations":[{"op":"edit","task_id":"{{CONFLICT_B}}","expected_revision":1,"description":"Parent proposal"}],"expected_graph_revision":0,"reason":"Pending parent proposal"}});
    let mut changed = first.clone();
    changed["instruction"]["operations"][0]["description"] = json!("Different payload");
    let mut disjoint = first.clone();
    disjoint["idempotency_key"] = json!("parent-disjoint");
    disjoint["instruction"]["operations"][0]["task_id"] = json!("{{CONFLICT_C}}");
    disjoint["instruction"]["operations"][0]["description"] = json!("Preserved independent edit");
    parent.response = calls(&[
        ("session_control", first.clone()),
        ("session_control", first),
        ("session_control", changed),
        ("session_control", disjoint),
    ]);
    for chunk in &mut parent.response.chunks {
        chunk.text = chunk.text.replace(
            "\\\"expected_graph_revision\\\":0",
            "\\\"expected_graph_revision\\\":{{CONFLICT_GRAPH}}",
        );
    }
    let mut parent_end = base;
    parent_end.request.key.user_request = PARENT.into();
    parent_end.request.key.round = [
        "function_call",
        "function_call",
        "function_call",
        "function_call",
        "function_call_output",
        "function_call_output",
        "function_call_output",
        "function_call_output",
    ]
    .map(str::to_owned)
    .to_vec();
    cassette
        .exchanges
        .extend([hold, final_answer, parent, parent_end]);
}

pub(super) async fn run(s: &Scenario, parent: &str, child: &str) -> Result<(), HarnessError> {
    let view = summary(s).await?;
    let task = &view["tasks"][0];
    let mut graph = view["graph_revision"].as_u64().unwrap();
    let mut ids = Vec::new();
    for key in ["B", "C"] {
        let result = user(s,child,&format!("add-conflict-{key}"),json!({"expected_graph_revision":graph,"reason":"Scoped follow-up for conflict check","operations":[{"op":"add","work_id":task["work_id"],"spec_ref":task["spec_ref"],"task":{"key":key,"description":key,"part_ids":task["part_ids"],"criterion_ids":task["criterion_ids"],"after":[task["id"]]}}]}),None).await?;
        assert_eq!(result["status"], "applied", "{result}");
        let id = result["result"]["operations"][0]["task"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        s.provider()?
            .add_placeholder(&format!("CONFLICT_{key}"), &id);
        ids.push(id);
        graph += 1;
    }
    s.provider()?
        .add_placeholder("CONFLICT_GRAPH", graph.to_string());
    user(s, child, "held-conflict", json!({"text":HOLD}), None).await?;
    held(s).await?;
    user(
        s,
        parent,
        "parent-conflict-round",
        json!({"text":PARENT}),
        None,
    )
    .await?;
    // The parent must finish its four calls before owner priority is decided.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let r = receipts(s, child).await?;
        if r["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["idempotency_key"] == "parent-disjoint")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Parent controls were not admitted: {r}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let owner = user(s,child,"owner-priority",json!({"expected_graph_revision":graph+1,"reason":"Owner supersedes B, after independent C","operations":[{"op":"edit","task_id":ids[0],"expected_revision":1,"description":"Owner decision"}]}),None).await?;
    assert_eq!(owner["status"], "pending_safe_point");
    tokio::fs::write(s.sandbox.data.join("e2e-instruction-release"), b"release").await?;
    applied(s, child, "owner-priority").await?;
    let r = receipts(s, child).await?;
    let instructions = r["instructions"].as_array().unwrap();
    assert_eq!(
        instructions
            .iter()
            .filter(|r| r["idempotency_key"] == "parent-conflict")
            .count(),
        1
    );
    let conflict = instructions
        .iter()
        .find(|r| r["idempotency_key"] == "parent-conflict")
        .unwrap();
    assert_eq!(conflict["status"], "superseded");
    assert_eq!(conflict["source_instruction_id"], owner["instruction_id"]);
    assert_eq!(
        instructions
            .iter()
            .find(|r| r["idempotency_key"] == "parent-disjoint")
            .unwrap()["status"],
        "applied"
    );
    let view = summary(s).await?;
    for (id, description) in ids
        .iter()
        .zip(["Owner decision", "Preserved independent edit"])
    {
        let task = view["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == *id)
            .unwrap();
        assert_eq!(task["description"], description);
        assert_eq!(task["revision"], 2);
    }
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("idempotency_conflict"))
    );
    Ok(())
}
