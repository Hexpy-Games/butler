#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "scripted provider assertions"
)]
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) type Requests = Arc<Mutex<Vec<Value>>>;
pub(super) async fn start() -> Result<(String, Requests, tokio::task::JoinHandle<()>), HarnessError>
{
    let requests = Requests::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(requests.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, requests, server))
}
pub(super) fn requests_for(requests: &Requests, prompt: &str) -> Vec<Value> {
    requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| {
            matching::key("/codex/responses", r, &Placeholders::default()).user_request == prompt
        })
        .cloned()
        .collect()
}
pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .filter_map(|item| serde_json::from_str::<Value>(item["output"].as_str()?).ok())
        .map(|value| value.get("output").cloned().unwrap_or(value))
        .collect()
}
async fn reply(
    State(requests): State<Requests>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let out = outputs(&body);
    let step = requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| {
            matching::key("/codex/responses", r, &Placeholders::default()).user_request
                == key.user_request
        })
        .count();
    let item = match key.user_request.as_str() {
        super::JOB => next(&out),
        "Write the single follow-up marker." if step == 0 => call(
            0,
            "write_file",
            &json!({"path":"direct-marker.txt","content":"direct edit"}),
        ),
        super::DESIGN if step == 0 => call(
            0,
            "work_apply",
            &json!({"reason":"Design the requested outcome","operations":[
                {"op":"spec.propose","node":{"title":"Requested design","goal":"Specify the outcome","criteria":["Outcome specified"],"constraints":[]}}
            ]}),
        ),
        super::CONTROL if step == 0 => call(
            0,
            "session_control",
            &json!({
            "target_session_id":"child","mode":"queue","instruction":{"text":"Report the result"},
            "expected_control_epoch":0,"idempotency_key":"instruction"}),
        ),
        _ => answer(),
    };
    requests.lock().unwrap().push(body);
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}
fn answer() -> Value {
    json!({"type":"message","id":"msg_done","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":"Checked.","annotations":[]}]})
}
fn call(index: usize, name: &str, args: &Value) -> Value {
    super::super::access_tiers::stub::call(&format!("wm_{index}"), name, args)
}
fn apply(index: usize, ops: &Value, task: &Value, graph: &Value) -> Value {
    let spec: Value = serde_json::from_str(task["spec_ref"].as_str().unwrap()).unwrap();
    let id = task["id"].as_str().unwrap();
    call(
        index,
        "work_apply",
        &json!({"reason":"Complete the requested markers and review",
        "spec_ref":spec,"expected_task_graph_revision":graph,
        "expected_revisions":{id:task["revision"]},"operations":ops}),
    )
}
fn next(out: &[Value]) -> Value {
    let index = out.len();
    if out.iter().any(|value| value["ok"] == false) {
        return answer();
    }
    if index == 0 {
        return call(
            0,
            "work_apply",
            &json!({"reason":"Write and verify two markers","operations":[
            {"op":"work.create_light","goal":"Write and verify markers","done_criteria":["Requested marker written","Result checked"],
             "tasks":[[{"key":"write","title":"Write marker","description":"Write the marker"}],[{"key":"verify","title":"Verify marker","description":"Integrate and review the marker"}]]},
            {"op":"task.start","task_id":"@write"}]}),
        );
    }
    let first = &out[0]["keys"]["write"];
    let second = &out[0]["keys"]["verify"];
    match index {
        1 => call(index, "work_read", &json!({"view":"task","task_id":first})),
        2 => call(
            index,
            "write_file",
            &json!({"path":"marker.txt","content":"requested marker"}),
        ),
        3 => apply(
            index,
            &settle(first, &out[1]["view"]["criteria"], 1),
            &out[1]["view"]["task"],
            &out[0]["task_graph_revision"],
        ),
        4 | 8 => call(index, "work_read", &json!({"view":"tasks"})),
        5 => {
            let task = &out[4]["view"]["chains"][0]["steps"][1]["tasks"][0];
            apply(
                index,
                &json!([
                    {"op":"task.start","task_id":second},
                    {"op":"part.add","key":"integrate","task_id":second,"kind":"integrate","title":"Integrate result"},
                    {"op":"part.add","key":"review","task_id":second,"kind":"review","title":"Review result","after_part_ids":["@integrate"]},
                    {"op":"part.start","part_id":"@integrate"}
                ]),
                task,
                &out[4]["task_graph_revision"],
            )
        }
        6 => call(index, "work_read", &json!({"view":"task","task_id":second})),
        7 => {
            let keys = &out[5]["keys"];
            let mut ops = vec![
                json!({"op":"task.submit","task_id":second,"part_id":keys["integrate"],"result_refs":["marker.txt"],"evidence_refs":["marker.txt"]}),
                json!({"op":"part.start","part_id":keys["review"]}),
                json!({"op":"task.submit","task_id":second,"part_id":keys["review"],"result_refs":["marker.txt"],"evidence_refs":["marker.txt"]}),
            ];
            let finish = settle(second, &out[6]["view"]["criteria"], 2);
            ops.extend(finish.as_array().unwrap().iter().skip(1).cloned());
            apply(
                index,
                &json!(ops),
                &out[6]["view"]["task"],
                &out[5]["task_graph_revision"],
            )
        }
        9 => call(
            index,
            "write_file",
            &json!({"path":"marker.txt","content":"must not overwrite after completion"}),
        ),
        _ => answer(),
    }
}
fn settle(task: &Value, criteria: &Value, result_revision: i64) -> Value {
    let judged: Vec<_> = criteria
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            json!({"criterion_ref":c,
        "met":true,"evidence_refs":["marker.txt"],"note":"Marker checked"})
        })
        .collect();
    json!([
        {"op":"task.submit","task_id":task,"result_refs":["marker.txt"],"evidence_refs":["marker.txt"]},
        {"op":"task.review","key":"accepted","task_id":task,"result_revision":result_revision,"verdict":"accept","criterion_results":judged},
        {"op":"task.complete","task_id":task,"review_ref":"@accepted"}
    ])
}
