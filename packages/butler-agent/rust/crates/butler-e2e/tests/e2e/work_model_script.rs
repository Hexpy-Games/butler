//! Scripted model operations shared by native delegation user flows.
use serde_json::{Value, json};

pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|value| value.get("output").cloned().unwrap_or(value))
        .collect()
}

pub(super) fn task_id(body: &Value) -> Value {
    for output in outputs(body).iter().rev() {
        if let Some(id) = output
            .pointer("/keys/t")
            .or_else(|| output.pointer("/view/task/id"))
        {
            return id.clone();
        }
        if let Some(chains) = output.pointer("/view/chains").and_then(Value::as_array) {
            let tasks: Vec<_> = chains
                .iter()
                .flat_map(|chain| chain["steps"].as_array().into_iter().flatten())
                .flat_map(|step| step["tasks"].as_array().into_iter().flatten())
                .collect();
            if let Some(task) = tasks
                .iter()
                .find(|task| matches!(task["status"].as_str(), Some("running" | "in_review")))
                .or_else(|| tasks.iter().find(|task| task["status"] == "blocked"))
                .or_else(|| tasks.last())
            {
                return task["id"].clone();
            }
        }
        if let Some(id) = output.pointer("/next_action/task_id") {
            return id.clone();
        }
    }
    Value::Null
}

pub(super) fn view(body: &Value) -> Value {
    outputs(body)
        .into_iter()
        .rev()
        .find_map(|output| {
            output
                .get("view")
                .filter(|view| view.get("task").is_some())
                .cloned()
        })
        .unwrap_or(Value::Null)
}

pub(super) fn graph(body: &Value) -> Value {
    outputs(body)
        .iter()
        .rev()
        .find_map(|output| output.get("task_graph_revision").cloned())
        .unwrap_or(json!(0))
}

pub(super) fn spec(body: &Value) -> Value {
    for output in outputs(body).iter().rev() {
        if let Some(spec) = output
            .pointer("/view/task/spec_ref")
            .and_then(Value::as_str)
            .and_then(|spec| serde_json::from_str(spec).ok())
        {
            return spec;
        }
        if let Some(published) = output.pointer("/view/published") {
            return json!({"node_id":published["node_id"],"revision":published["revision"],"body_hash":published["body_hash"]});
        }
    }
    Value::Null
}

pub(super) fn part(body: &Value) -> Value {
    view(body)["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|part| part["status"] == "running")
        .map(|part| part["id"].clone())
        .unwrap_or(Value::Null)
}

pub(super) fn bootstrap(goal: &str, checks: &[&str]) -> Value {
    let spec = json!({"node_id":"@s","revision":1,"body_hash":"@s"});
    let detail = json!({"node_id":"@detail","revision":1,"body_hash":"@detail"});
    let mut criteria: Vec<Value> = checks
        .iter()
        .enumerate()
        .map(|(i, _)| json!({"node_id":"@s","node_revision":1,"criterion_id":format!("c{i}")}))
        .collect();
    criteria.push(json!({"node_id":"@detail","node_revision":1,"criterion_id":"c0"}));
    json!({"reason":"Specify and execute the requested delegated outcome","spec_ref":spec,"expected_task_graph_revision":0,
    "operations":[
        {"op":"spec.propose","key":"s","node":{"title":goal,"goal":goal,"criteria":checks,"constraints":[]}},
        {"op":"spec.propose","key":"detail","node":{"title":"Execution detail","goal":goal,"criteria":["Bounded output verified"],"constraints":[]}},
        {"op":"spec.activate","published_refs":[spec,detail],"expected_tree_version":0},
        {"op":"task.add","run_here":true,"key":"t","title":goal,"description":goal,"step":"new","acceptance_refs":criteria},
        {"op":"task.start","task_id":"@t"}
    ]})
}

pub(super) fn apply(body: &Value, operations: Value) -> Value {
    let mut input = json!({"reason":"Apply the requested outcome and its evidence","spec_ref":spec(body),
        "expected_task_graph_revision":graph(body)});
    butler_core::json::object_mut(&mut input).insert("operations".into(), operations);
    input
}

pub(super) fn submit(body: &Value, summary: &str) -> Value {
    apply(
        body,
        json!([{"op":"task.submit","task_id":task_id(body),"part_id":part(body),"result_refs":[summary],"evidence_refs":[summary]}]),
    )
}

pub(super) fn block(body: &Value, reason: &str) -> Value {
    apply(
        body,
        json!([{"op":"task.block","task_id":task_id(body),"part_id":part(body),"reason":reason,"checkpoint_ref":reason}]),
    )
}

pub(super) fn extend(body: &Value, goal: &str) -> Value {
    apply(
        body,
        json!([
            {"op":"task.add","run_here":true,"key":"t","title":goal,"description":goal,"step":"new","acceptance_refs":view(body)["criteria"]},
            {"op":"task.start","task_id":"@t"}
        ]),
    )
}

pub(super) fn complete(body: &Value) -> Option<Value> {
    let view = view(body);
    if view["parts"]
        .as_array()?
        .iter()
        .any(|part| !matches!(part["status"].as_str(), Some("completed" | "cancelled")))
    {
        return None;
    }
    if view["results"].as_array()?.is_empty() {
        return None;
    }
    let task = &view["task"];
    if task["status"] == "completed" {
        return None;
    }
    let judgments:Vec<_>=view["criteria"].as_array()?.iter().map(|criterion|json!({"criterion_ref":criterion,"met":true,"evidence_refs":["Observed delegated output"],"note":"Verified"})).collect();
    let old_revision = view["results"][0]["revision"].as_i64().unwrap_or(0);
    let mut ops = Vec::new();
    let resumed = !matches!(task["status"].as_str(), Some("running" | "in_review"));
    if resumed {
        ops.push(json!({"op":"task.start","task_id":task["id"]}));
        ops.push(json!({"op":"task.submit","task_id":task["id"],"result_refs":["Observed delegated output"],"evidence_refs":["Observed delegated output"]}));
    }
    ops.push(json!({"op":"task.review","key":"review","task_id":task["id"],"result_revision":old_revision+i64::from(resumed),"verdict":"accept","criterion_results":judgments}));
    ops.push(json!({"op":"task.complete","task_id":task["id"],"review_ref":"@review"}));
    Some(apply(body, json!(ops)))
}

pub(super) fn fill(value: Value, body: &Value) -> Value {
    match value {
        Value::String(ref text) => match text.as_str() {
            "{{TASK}}" => task_id(body),
            "{{PART}}" => part(body),
            "{{SPEC}}" => spec(body),
            "{{GRAPH}}" => graph(body),
            "{{ACCEPTANCE}}" => view(body)["criteria"].clone(),
            _ => value,
        },
        Value::Array(values) => values.into_iter().map(|value| fill(value, body)).collect(),
        Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| (key, fill(value, body)))
            .collect(),
        _ => value,
    }
}
