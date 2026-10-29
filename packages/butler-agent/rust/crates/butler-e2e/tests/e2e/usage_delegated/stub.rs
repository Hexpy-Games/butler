//! Synthetic chat -> steward -> two workers, through the native tool gateway.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt::Write,
    sync::{Arc, Mutex},
};
/// The branch summarizer's instructions (`topic_branch.rs`).
pub(super) const SUMMARY: &str = "Summarize the quoted conversation for a new conversation.";
#[derive(Default)]
pub(super) struct Script {
    works: Mutex<HashMap<String, String>>,
    steps: Mutex<HashMap<String, usize>>,
    pub(super) calls: Mutex<Vec<(String, u64, u64)>>,
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(script.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, script, handle))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    let instructions = body["instructions"].as_str().unwrap_or("");
    let role = if instructions.starts_with(SUMMARY) {
        "summary"
    } else if instructions.contains("You run one delegated Work for Butler")
        || key.user_request.starts_with("role: steward")
    {
        "steward"
    } else if key.user_request.starts_with("role: worker") {
        if key.user_request.contains("Verify Beta") {
            "worker-b"
        } else {
            "worker-a"
        }
    } else {
        "main"
    };
    let step = {
        let mut steps = script.steps.lock().unwrap();
        let n = steps.entry(role.into()).or_default();
        let step = *n;
        *n += 1;
        step
    };
    let replay: Value =
        serde_json::from_str(include_str!("../delegate_followup/replay.json")).unwrap();
    let work = {
        let mut works = script.works.lock().unwrap();
        let observed = work_id(&body);
        if !observed.is_empty() {
            works.insert(role.into(), observed);
        }
        works.get(role).cloned().unwrap_or_default()
    };
    let template = match role {
        "main" if step < 1 => replay["parent"][step].clone(),
        "steward" => steward(step, &work),
        "worker-a" | "worker-b" => worker(step, &work),
        _ => json!({"type":"message","text":"Verified evidence."}),
    };
    let encoded = template.to_string().replace("{{WORK}}", &work);
    let template: Value = serde_json::from_str(&encoded).unwrap();
    let item = if template["type"] == "function_call" {
        json!({"type":"function_call","id":format!("{role}-{step}"),"call_id":format!("{role}-{step}"),"name":template["name"],"arguments":template["arguments"].to_string(),"status":"completed"})
    } else {
        message(template["text"].as_str().unwrap())
    };
    let (input, output) = match role {
        "main" => (100, 20),
        "steward" => (200, 30),
        "worker-a" => (300, 40),
        _ => (400, 50),
    };
    script
        .calls
        .lock()
        .unwrap()
        .push((role.into(), input, output));
    (
        [("content-type", "text/event-stream")],
        wire(item, input, output),
    )
}
fn steward(step: usize, work: &str) -> Value {
    match step {
        0 => {
            json!({"type":"function_call","name":"replace_work_plan","arguments":{"objective":"Verify evidence","execution_mode":"workers","actions":[{"action_key":"alpha","description":"Verify Alpha","dependency_keys":[]},{"action_key":"beta","description":"Verify Beta","dependency_keys":[]}],"checks":["Evidence verified"]}})
        }
        1 => {
            json!({"type":"function_call","name":"record_work_review","arguments":{"subject":"plan","verdict":"accept","summary":"Ready"}})
        }
        2 | 4 => {
            let (action, objective) = if step == 2 {
                ("alpha", "Verify Alpha")
            } else {
                ("beta", "Verify Beta")
            };
            json!({"type":"function_call","name":"delegate_to_worker","arguments":{"action_key":action,"objective":objective,"acceptance_criteria":["Evidence verified"],"implementation_brief":objective,"safe_title":objective}})
        }
        3 | 5 => json!({"type":"function_call","name":"wait_for_worker","arguments":{}}),
        6 => {
            json!({"type":"function_call","name":"record_work_disposition","arguments":{"work_id":work,"disposition":"completed","summary":"Both sources verified","action_updates":[{"action_key":"alpha","status":"done"},{"action_key":"beta","status":"done"}],"remaining_actions":[],"followups":[]}})
        }
        _ => json!({"type":"message","text":"Both sources verified."}),
    }
}
fn worker(step: usize, work: &str) -> Value {
    match step {
        0 => {
            json!({"type":"function_call","name":"replace_work_plan","arguments":{"objective":"Verify evidence","execution_mode":"direct","actions":[{"action_key":"verify","description":"Verify evidence","dependency_keys":[]}],"checks":["Evidence verified"]}})
        }
        1 => {
            json!({"type":"function_call","name":"record_work_review","arguments":{"subject":"plan","verdict":"accept","summary":"Ready"}})
        }
        2 => {
            json!({"type":"function_call","name":"record_work_disposition","arguments":{"work_id":work,"disposition":"completed","summary":"Evidence verified","action_updates":[{"action_key":"verify","status":"done"}],"remaining_actions":[],"followups":[]}})
        }
        _ => json!({"type":"message","text":"Verified evidence."}),
    }
}
fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find_map(|v| {
            v.pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn wire(item: Value, input: u64, output: u64) -> String {
    let items = if let Some(batch) = item.as_array() {
        let mut items = vec![message("이전 결과를 바탕으로 다시 조사하겠습니다.")];
        items.extend(batch.iter().cloned());
        items
    } else if item["call_id"] == "delegate" {
        vec![message("이전 결과를 바탕으로 다시 조사하겠습니다."), item]
    } else {
        vec![item]
    };
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"stub","status":"in_progress","output":[]}}),
    ];
    for (index, item) in items.iter().enumerate() {
        events.push(json!({"type":"response.output_item.added","output_index":index,"item":item}));
        if item["type"] == "function_call" {
            events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":index,"delta":item["arguments"]}));
            events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":index,"arguments":item["arguments"]}));
        } else {
            events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":index,"content_index":0,"delta":item["content"][0]["text"]}));
        }
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
    }
    events.push(json!({"type":"response.completed","response":{"id":"stub","object":"response","status":"completed","model":"gpt-6-luna","output":items,"usage":{"input_tokens":input,"input_tokens_details":{"cached_tokens":10},"output_tokens":output,"total_tokens":input+output}}}));
    events
        .into_iter()
        .enumerate()
        .fold(String::new(), |mut output, (n, mut event)| {
            event["sequence_number"] = json!(n);
            write!(
                output,
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
            .unwrap();
            output
        })
}
