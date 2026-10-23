//! The parent publishes, corrects, activates and starts its native Task.
use super::super::{access_tiers::stub::call, work_model_script as native};
use super::stub::{OWNER, REVISED_CHECK};
use serde_json::{Value, json};

pub(super) fn parent_item(step: usize, body: &Value, presented: bool) -> Value {
    match step {
        0 => call(
            "spec",
            "work_apply",
            &json!({"reason":"Specify the requested comparison","operations":[
                {"op":"spec.propose","key":"s","node":{"title":OWNER,"goal":OWNER,"criteria":["Approach verified"],"constraints":[]}}
            ]}),
        ),
        1 | 3 => call(
            &format!("read-spec-{step}"),
            "work_read",
            &json!({"view":"spec","revision":if step==1 {"1"}else{"2"}}),
        ),
        2 => revise(body, presented),
        4 => start(body),
        5 => {
            let compare = native::outputs(body)
                .iter()
                .rev()
                .find_map(|output| output.pointer("/keys/compare"))
                .cloned()
                .unwrap();
            call(
                "delegate",
                "delegate_to_steward",
                &json!({"request":OWNER,"part_id":compare}),
            )
        }
        _ => {
            json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Direction delivered.","annotations":[]}]})
        }
    }
}

fn revise(body: &Value, presented: bool) -> Value {
    let spec = native::spec(body);
    let node = spec["node_id"].as_str().unwrap();
    let node_revision = native::outputs(body).last().unwrap()["view"]["node"]["revision"].clone();
    let mut checks = vec![
        "Approach verified",
        REVISED_CHECK,
        "Goal: Choose the better approach for the owner's next step",
        "Deliver: A one-line recommendation",
        "Next: Apply the chosen approach",
        "Assumed: Both files are current",
    ];
    if presented {
        checks.push("Presentation: cards, table");
    }
    call(
        "revise-spec",
        "work_apply",
        &json!({"reason":"Name the deciding criterion before execution","spec_ref":spec,
        "expected_revisions":{node:node_revision},"operations":[
            {"op":"spec.propose","key":"revised","node_id":node,"node":{"title":OWNER,"goal":OWNER,"criteria":checks,"constraints":[]}},
            {"op":"spec.propose","key":"detail","node":{"title":"Comparison method","goal":"Read both approaches and verify the recommendation","criteria":["Comparison evidence retained"],"constraints":[]}},
            {"op":"spec.activate","expected_tree_version":0,"published_refs":[
                {"node_id":"@revised","revision":2,"body_hash":"@revised"},
                {"node_id":"@detail","revision":1,"body_hash":"@detail"}
            ]}
        ]}),
    )
}

fn start(body: &Value) -> Value {
    let outputs = native::outputs(body);
    let published = outputs
        .iter()
        .rev()
        .find_map(|output| output.pointer("/view/published"))
        .unwrap();
    let criteria = outputs
        .iter()
        .rev()
        .find_map(|output| output.pointer("/view/criteria"))
        .unwrap();
    let detail = outputs
        .iter()
        .rev()
        .find_map(|output| output.pointer("/keys/detail"))
        .unwrap();
    let mut acceptance:Vec<_>=criteria.as_array().unwrap().iter().map(|criterion|json!({
        "node_id":published["node_id"],"node_revision":published["revision"],"criterion_id":criterion["criterion_id"]})).collect();
    acceptance.push(json!({"node_id":detail,"node_revision":1,"criterion_id":"c0"}));
    call(
        "start-task",
        "work_apply",
        &native::apply(
            body,
            json!([
                {"op":"task.add","key":"t","title":OWNER,"description":OWNER,"step":"new","acceptance_refs":acceptance},
                {"op":"task.start","task_id":"@t"},
                {"op":"part.add","key":"read","task_id":"@t","kind":"execute","title":"Read approach A"},
                {"op":"part.add","key":"compare","task_id":"@t","kind":"execute","title":"Compare approaches"},
                {"op":"part.start","part_id":"@read"},
                {"op":"task.submit","task_id":"@t","part_id":"@read","result_refs":["Approach A read"],"evidence_refs":["a.txt"]}
            ]),
        ),
    )
}
