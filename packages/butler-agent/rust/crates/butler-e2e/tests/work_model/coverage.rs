use super::{recursive, work_model::*};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};

async fn command(
    s: &Scenario,
    instruction: &str,
    key: &str,
    command: Value,
) -> Result<Value, HarnessError> {
    apply(s,json!({"instruction_id":instruction,"idempotency_key":key,"expected_graph_revision":1,"command":command})).await
}
async fn finish_task(s: &Scenario, instruction: &str, id: &Value) -> Result<(), HarnessError> {
    for (revision, action) in [
        json!({"op":"start"}),
        json!({"op":"submit","result_refs":["artifact:complete"],"evidence_refs":["test:exact"]}),
        json!({"op":"review","result_revision":1,"criterion_results":[{"criterion_id":"AC","verdict":"pass","reason":"Exact public response verified","evidence_refs":["test:exact"]}]}),
        json!({"op":"complete"}),
    ].into_iter().enumerate() {
        let mut action=action;
        action["task_id"]=id.clone();
        action["expected_revision"]=json!(revision+1);
        let key=format!("{}-{revision}",id.as_str().unwrap());
        let receipt=command(s,instruction,&key,action).await?;
        assert_eq!(receipt["ok"],true,"{receipt}");
    }
    Ok(())
}

pub(super) async fn run() -> Result<(), HarnessError> {
    let (s, instruction) = setup("WM-15-COVERAGE").await?;
    let mut bundle = recursive::bundle(3);
    bundle["nodes"][0]["child_coverage"] =
        json!([{"criterion_id":"AC","child_node_id":"feature","child_criterion_id":"AC"}]);
    bundle["nodes"][1]["child_coverage"] =
        json!([{"criterion_id":"AC","child_node_id":"buildable","child_criterion_id":"AC"}]);
    bundle["nodes"][0]["criteria"].as_array_mut().unwrap().push(json!({"id":"INTEGRATION","part_id":"API","text":"Parent integration has independent evidence","verification":"Integration E2E"}));
    assert_eq!(
        command(
            &s,
            &instruction,
            "create",
            json!({"op":"create","bundle":bundle})
        )
        .await?["ok"],
        true
    );
    let view = summary(&s).await?;
    let tasks = view["tasks"].as_array().unwrap();
    let root_work = tasks[0]["work_id"].clone();
    assert_eq!(tasks.len(), 3);
    for (i, task) in tasks.iter().enumerate() {
        finish_task(&s, &instruction, &task["id"]).await?;
        let receipt = command(
            &s,
            &instruction,
            &format!("root-{i}"),
            json!({"op":"complete_work","work_id":root_work}),
        )
        .await?;
        if i < 2 {
            assert_eq!(
                receipt["error"]["code"], "criterion_coverage_incomplete",
                "{receipt}"
            );
        } else {
            assert_eq!(receipt["ok"], true, "{receipt}");
        }
    }
    for task in tasks.iter().skip(1) {
        let receipt = command(
            &s,
            &instruction,
            task["work_id"].as_str().unwrap(),
            json!({"op":"complete_work","work_id":task["work_id"]}),
        )
        .await?;
        assert_eq!(receipt["ok"], true, "{receipt}");
    }
    let receipt = command(&s, &instruction, "plan", json!({"op":"complete_plan"})).await?;
    assert_eq!(receipt["error"]["code"], "criterion_coverage_incomplete");
    assert_eq!(summary(&s).await?["counts"]["completed"], 3);
    s.finish().await
}
