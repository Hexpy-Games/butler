//! Scripted provider: a Steward loses the browser host mid-delegation.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::{
    fmt::Write,
    sync::{Arc, Mutex},
};

pub(super) const OWNER: &str = "Delegate checking https://example.com/ on a phone-width page.";
pub(super) const ANSWER: &str = "The browser disconnected before the page could be checked.";
const ACTION: &str = "check";

#[derive(Default)]
pub(super) struct Script {
    steps: Mutex<[usize; 3]>,
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
        1
    } else if key.user_request.contains("Delegated result") {
        2
    } else {
        0
    };
    let step = {
        let mut steps = script.steps.lock().unwrap();
        let n = steps[lane];
        steps[lane] += 1;
        n
    };
    let item = match lane {
        1 => child(step, &body),
        2 => message(ANSWER),
        _ => parent(step),
    };
    ([("content-type", "text/event-stream")], wire(&item)).into_response()
}

fn parent(step: usize) -> Value {
    match step {
        0 => call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":OWNER,"checks":["The page is checked at phone width."],"safe_title":"Phone page check"}),
        ),
        _ => message("Checking the page."),
    }
}

fn child(step: usize, body: &Value) -> Value {
    match step {
        0 => call("child-plan", "replace_work_plan", &plan("direct")),
        1 => call("child-review", "record_work_review", &review()),
        2 => call(
            "describe",
            "tool_describe",
            &json!({"ids":["native:browser_open"]}),
        ),
        3 => call(
            "open",
            "tool_call",
            &json!({"id":"native:browser_open","arguments":{"url":"https://example.com/"}}),
        ),
        // The D2 model handed back the very tool that had just failed.
        4 => call(
            "handoff",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"blocked",
                "summary":"The browser host was lost.","remaining_actions":[ACTION],
                "action_updates":[{"action_key":ACTION,"status":"blocked"}],
                "capability_handoff":{"code":"capability_unavailable_in_child",
                    "requested_action":{"tool_name":"browser_open",
                        "arguments":{"url":"https://example.com/"}}}}),
        ),
        5 => call(
            "blocked",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"blocked",
                "summary":"The page could not be opened: the browser host was lost.",
                "action_updates":[],"remaining_actions":[ACTION],
                "next_condition":"A browser host is available.","followups":[]}),
        ),
        _ => message("The page could not be opened."),
    }
}

fn plan(mode: &str) -> Value {
    json!({"objective":OWNER,"execution_mode":mode,"governing_refs":[],
        "actions":[{"action_key":ACTION,"description":"Check the page","dependency_keys":[]}],
        "checks":["The page is checked at phone width."]})
}

fn review() -> Value {
    json!({"subject":"plan","verdict":"accept","summary":"Ready","corrections":[],"action_updates":[]})
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
                output["work"]["work_id"]
                    .as_str()
                    .or_else(|| output.pointer("/output/work/work_id")?.as_str())
                    .map(str::to_owned)
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

fn wire(item: &Value) -> String {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"stub","status":"in_progress","output":[]}}),
    ];
    events.push(json!({"type":"response.output_item.added","output_index":0,"item":item}));
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"stub","object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
