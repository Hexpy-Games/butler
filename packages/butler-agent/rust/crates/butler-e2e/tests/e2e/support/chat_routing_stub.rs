//! Scripted chat routing; all model traffic remains local.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt::Write,
    sync::{Arc, Mutex},
};

pub(super) const KNOWLEDGE: &str = "What does HTTP stand for?";
pub(super) const LOOKUP: &str = "Look up the current weather in Seoul.";
pub(super) const PROJECT: &str = "What does HTTPS add to HTTP?";
pub(super) const SCHEDULED: &str = "Send me a short morning greeting.";
pub(super) const CHAT_ROUTE: &str =
    "Delegate everything else with one delegate_to_steward call, even a single step";
pub(super) const DEFAULT_ROUTE: &str = "Do it yourself, no Work:";
#[derive(Default)]
pub(super) struct Script {
    steps: Mutex<HashMap<String, usize>>,
    pub requests: Mutex<Vec<Value>>,
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((url, script, server))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    script.requests.lock().unwrap().push(body.clone());
    let lane = if key.user_request.starts_with("role: steward") {
        "child"
    } else if key.user_request.contains("Delegated result") {
        "result"
    } else if key.user_request == LOOKUP {
        "lookup"
    } else {
        "other"
    };
    let step = {
        let mut steps = script.steps.lock().unwrap();
        let n = steps.entry(lane.into()).or_default();
        let step = *n;
        *n += 1;
        step
    };
    let item = match lane {
        "child" => child(step, &body),
        "result" => message("서울은 맑습니다."),
        "lookup" => match step {
            0 => call(
                "delegate",
                "delegate_to_steward",
                &json!({"request":LOOKUP,"checks":["Weather reported"],"safe_title":"Seoul weather"}),
            ),
            _ => message("확인을 맡겼습니다."),
        },
        _ => message("Done."),
    };
    ([("content-type", "text/event-stream")], wire(item)).into_response()
}
fn child(step: usize, body: &Value) -> Value {
    match step {
        0 => call(
            "child-plan",
            "replace_work_plan",
            &json!({"objective":LOOKUP,"execution_mode":"direct",
                "actions":[{"action_key":"weather","description":"Check Seoul weather"}],
                "checks":["Weather reported"]}),
        ),
        1 => call(
            "child-review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
        ),
        2 => call(
            "settle",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"completed","summary":"Seoul weather checked",
                "action_updates":[{"action_key":"weather","status":"done"}],"remaining_actions":[]}),
        ),
        _ => message("Seoul is clear."),
    }
}
fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find_map(|item| {
            if item["type"] == "function_call_output" {
                let output: Value = serde_json::from_str(item["output"].as_str()?).ok()?;
                output["work"]["work_id"].as_str().map(str::to_owned)
            } else {
                item["content"].as_array()?.iter().find_map(|part| {
                    part["text"].as_str()?.lines().find_map(|line| {
                        line.strip_prefix(
                            "Explicit relation Work id (model-only; never report to user): ",
                        )
                        .map(str::to_owned)
                    })
                })
            }
        })
        .unwrap()
}
fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn wire(item: Value) -> String {
    let items = if item["call_id"] == "delegate" {
        vec![message("I'll compare both approaches."), item]
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
    events.push(json!({"type":"response.completed","response":{"id":"stub","object":"response","status":"completed","model":"gpt-6-luna","output":items,"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
