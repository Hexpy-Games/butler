use super::work_model::*;
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
#[path = "publication_cli.rs"]
mod cli;

pub(super) fn bundle(tasks: usize) -> Value {
    let nodes = ["goal", "feature", "buildable"].iter().enumerate().map(|(i, id)| json!({
        "node_id":id,"parent_id":if i==0 {None} else {Some(["goal","feature"][i-1])},
        "concern_id":id,"responsibility":format!("{id} owns its interface and integration"),"kind":"software",
        "parts":[{"id":"API","behaviour":"Complete public response","design":"Typed data, bounded index queries, errors preserve state","implementation":"Use existing transaction and publication owners"}],
        "criteria":[{"id":"AC","part_id":"API","text":"Exact response and state","verification":"Public path E2E with exact counts"}],
        "source_refs":["request"],"child_coverage":[]
    })).collect::<Vec<_>>();
    let works = nodes.iter().map(|n| json!({"key":n["node_id"],"node_id":n["node_id"],"outcome":"Verified interface","part_ids":["API"],"criterion_ids":["AC"]})).collect::<Vec<_>>();
    let tasks = (0..tasks).map(|i| {let node=["goal","feature","buildable"][i%3];json!({
        "key":format!("t{i}"),"description":format!("Verify {node} {i}"),"work_key":node,"node_id":node,
        "part_ids":["API"],"criterion_ids":["AC"],"after":if i<3 {vec![]} else {(i-3..i).map(|j| format!("t{j}")).collect::<Vec<_>>()}
    })}).collect::<Vec<_>>();
    json!({"tier":2,"goal":"Implement complete API","root_node_id":"goal","nodes":nodes,"works":works,"tasks":tasks})
}

pub(super) async fn publication() -> Result<(), HarnessError> {
    let (mut s, instruction) = setup("WM-14-RECURSIVE").await?;
    let bundle = bundle(6);
    let request = |key: &str, command: Value| json!({"instruction_id":instruction,"idempotency_key":key,"command":command});
    let mut invalid = bundle.clone();
    invalid["nodes"][2]["concern_id"] = json!("feature");
    assert_eq!(
        apply(
            &s,
            request("competing", json!({"op":"create","bundle":invalid}))
        )
        .await?["error"]["code"],
        "spec_concern_conflict"
    );
    let mut invalid = bundle.clone();
    invalid["tasks"][0]["node_id"] = json!("foreign");
    assert_eq!(
        apply(
            &s,
            request("foreign-binding", json!({"op":"create","bundle":invalid}))
        )
        .await?["error"]["code"],
        "task_spec_outside_work"
    );
    assert_eq!(summary(&s).await?["total"], 0);
    let input = request("publish", json!({"op":"publish","nodes":bundle["nodes"]}));
    let published = apply(&s, input.clone()).await?;
    assert_eq!(published["ok"], true, "{published}");
    assert_eq!(published["active"], false);
    assert_eq!(summary(&s).await?["total"], 0);
    s.restart().await?;
    assert_eq!(apply(&s, input).await?, published);
    let refs = &published["published_refs"];
    cli::immutable(&s, refs[0]["ledger_revision_id"].as_str().unwrap()).await?;
    let activate = |refs: Value| json!({"op":"activate","tier":2,"goal":bundle["goal"],"root_node_id":"goal","published_refs":refs,"works":bundle["works"],"tasks":bundle["tasks"]});
    let mut damaged = refs.clone();
    damaged[0]["content_hash"] = json!("wrong");
    assert_eq!(
        apply(&s, request("hash-mismatch", activate(damaged))).await?["ok"],
        false
    );
    assert_eq!(summary(&s).await?["total"], 0);
    let mut unpublished = refs.clone();
    unpublished[0]["node_revision"] = json!(2);
    let id = unpublished[0]["ledger_revision_id"].as_str().unwrap();
    unpublished[0]["ledger_revision_id"] = json!(format!("{}-R2", id.strip_suffix("-R1").unwrap()));
    assert_eq!(
        apply(&s, request("unpublished", activate(unpublished))).await?["error"]["code"],
        "spec_unpublished"
    );
    let mut foreign = refs.clone();
    foreign[0]["ledger_revision_id"] = json!("SPEC-WM-foreign-R1");
    assert_eq!(
        apply(&s, request("foreign-revision", activate(foreign))).await?["error"]["code"],
        "spec_scope_invalid"
    );
    assert_eq!(summary(&s).await?["total"], 0);
    let accepted = apply(&s, request("activate", activate(refs.clone()))).await?;
    assert_eq!(accepted["ok"], true, "{accepted}");
    let view = summary(&s).await?;
    assert_eq!(view["tier"], 2);
    assert_eq!(view["total"], 6);
    assert_eq!(view["spec_count"], 3);
    let plan = accepted["plan_id"].as_str().unwrap();
    let graph =
        s.gw.get(&format!("/plans/{plan}/task-graph?revision=1"))
            .await?;
    assert_eq!(graph.status, 200, "{}", graph.text);
    assert_eq!(graph.data()["tasks"].as_array().unwrap().len(), 6);
    assert_eq!(graph.data()["edges"].as_array().unwrap().len(), 9);
    let spec =
        s.gw.get("/sessions/general/work-spec?node_id=buildable")
            .await?;
    assert_eq!(spec.status, 200, "{}", spec.text);
    let ancestors = spec.data()["nodes"].as_array().unwrap();
    assert_eq!(ancestors.len(), 3);
    assert_eq!(ancestors[0]["node"]["node_id"], "buildable");
    assert_eq!(ancestors[2]["node"]["node_id"], "goal");
    s.restart().await?;
    assert_eq!(summary(&s).await?, view);
    s.finish().await
}
