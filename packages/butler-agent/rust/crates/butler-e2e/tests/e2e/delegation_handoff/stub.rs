//! Scripted provider: asserts runtime routing, never a real model's choices.
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

pub(super) struct Script {
    pub mode: Mode,
    pub requests: Mutex<Vec<(String, Value)>>,
    pub stage: AtomicUsize,
    pub first_relation: Mutex<String>,
    pub work: Mutex<String>,
    pub data: Mutex<std::path::PathBuf>,
    pub replacement_settled: AtomicBool,
}

pub(super) async fn start(
    mode: Mode,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        mode,
        requests: Mutex::default(),
        stage: AtomicUsize::new(0),
        first_relation: Mutex::default(),
        work: Mutex::default(),
        data: Mutex::default(),
        replacement_settled: AtomicBool::new(false),
    });
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((url, script, server))
}

async fn reply(State(script): State<Arc<Script>>, Json(body): Json<Value>) -> impl IntoResponse {
    if crate::connectors::stub::find_spec(&body["input"]).is_some() {
        let response = crate::connectors::stub::run(&body).unwrap();
        return (
            [("content-type", "text/event-stream")],
            response
                .chunks
                .into_iter()
                .map(|c| c.text)
                .collect::<String>(),
        );
    }
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let user = &key.user_request;
    let role = if user.starts_with("role: worker") {
        "worker"
    } else if user.starts_with("role: steward")
        || body["instructions"]
            .as_str()
            .unwrap_or("")
            .contains("You run one delegated Work")
    {
        "steward"
    } else {
        "butler"
    };
    script
        .requests
        .lock()
        .unwrap()
        .push((role.into(), body.clone()));
    let step = key
        .round
        .iter()
        .filter(|kind| kind.as_str() == "function_call_output")
        .count();
    let item = match role {
        "worker" => {
            if script.mode == Mode::Replace && user.contains("assigned_objective: first attempt") {
                // Cancellation drops the provider request; this late response cannot become success.
                std::future::pending::<()>().await;
            }
            if script.mode == Mode::Replace && step == 0 {
                let db = rusqlite::Connection::open(
                    script
                        .data
                        .lock()
                        .unwrap()
                        .join("agent-runtime/btcc.sqlite"),
                )
                .unwrap();
                let ended: bool = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE relation_id=?1)",
                        [&*script.first_relation.lock().unwrap()],
                        |r| r.get(0),
                    )
                    .unwrap();
                script.replacement_settled.store(ended, Ordering::SeqCst);
            }
            worker(script.mode, step, &body)
        }
        "steward" => {
            if user.starts_with("Superseded Worker result:") {
                call("wait_for_worker", json!({}))
            } else {
                steward(&script, script.stage.fetch_add(1, Ordering::SeqCst), &body)
            }
        }
        _ if user.starts_with("Delegated result") => message("Handoff complete."),
        _ => match step {
            0 => describe(),
            1 => call(
                "delegate_to_steward",
                json!({"request":READING,"checks":["Findings recorded"],"safe_title":"Research findings"}),
            ),
            _ => message("Research started."),
        },
    };
    let id = format!("{role}-{}-{step}", script.requests.lock().unwrap().len());
    ([("content-type", "text/event-stream")], wire(&item, &id))
}

fn describe() -> Value {
    call(
        "tool_describe",
        json!({"ids":["native:document_create","native:output_publish"]}),
    )
}
fn assign(objective: &str, replacement: Option<&str>) -> Value {
    let mut args = json!({"action_key":"A","objective":objective,"acceptance_criteria":["Findings recorded"],"implementation_brief":"Use confirmed evidence and report gaps"});
    if let Some(relation) = replacement {
        args["replaces_relation_id"] = relation.into();
    }
    call("delegate_to_worker", args)
}
fn steward(script: &Script, stage: usize, body: &Value) -> Value {
    if let Some(work) = outputs(body)
        .iter()
        .rev()
        .find_map(|v| v["work"]["work_id"].as_str().map(str::to_owned))
    {
        *script.work.lock().unwrap() = work;
    }
    let mode = script.mode;
    if mode == Mode::Replace && stage == 4 {
        let relation = outputs(body)
            .into_iter()
            .find_map(|v| v["relation_id"].as_str().map(str::to_owned))
            .unwrap();
        *script.first_relation.lock().unwrap() = relation;
        return assign(
            "replacement attempt",
            Some(&script.first_relation.lock().unwrap()),
        );
    }
    let stage = if mode == Mode::Replace && stage >= 5 {
        stage - 1
    } else {
        stage
    };
    match stage {
        0 => describe(),
        1 => {
            let mut actions = vec![json!({"action_key":"A","description":"Find confirmed facts"})];
            if mode == Mode::Facts {
                actions.push(json!({"action_key":"B","description":"Use earlier facts","dependency_keys":["A"]}));
            }
            call(
                "replace_work_plan",
                json!({"objective":"Research findings","execution_mode":"workers","subjects":[{"key":"report","label":"Report"}],"actions":actions,"checks":["Findings recorded"]}),
            )
        }
        2 => review(),
        3 => assign("first attempt", None),
        4 => call("wait_for_worker", json!({})),
        5 => call(
            "record_work_checkpoint",
            json!({"action_updates":[{"action_key":"A","status":"done"}],"public_summary":"Findings recorded"}),
        ),
        6 if mode == Mode::Facts => {
            let db = rusqlite::Connection::open(
                script
                    .data
                    .lock()
                    .unwrap()
                    .join("agent-runtime/btcc.sqlite"),
            )
            .unwrap();
            let a: String = db
                .query_row(
                    "SELECT task_id FROM btcc_work_tasks WHERE action_key='A'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            call(
                "delegate_to_worker",
                json!({"action_key":"B","objective":"next step","acceptance_criteria":["Findings recorded"],"implementation_brief":"Use confirmed evidence and report gaps","task":{"scope":{"paths":["tasks/B"]},"output":{"format":"text","fields":["summary"]},"inputs":[{"task":a,"use":"facts"}]}}),
            )
        }
        7 if mode == Mode::Facts => call("wait_for_worker", json!({})),
        6 => call(
            "document_create",
            json!({"title":"Research report","body":FACTS}),
        ),
        n if n == if mode == Mode::Facts { 8 } else { 7 } => {
            let mut updates = vec![json!({"action_key":"A","status":"done"})];
            if mode == Mode::Facts {
                updates.push(json!({"action_key":"B","status":"done"}));
            }
            let mut result = disposition(body, &updates);
            result["arguments"]["work_id"] = script.work.lock().unwrap().clone().into();
            result
        }
        _ => message("Findings recorded."),
    }
}
fn worker(mode: Mode, step: usize, body: &Value) -> Value {
    match step {
        0 if mode == Mode::Scope => call("tool_describe", json!({"ids":["native:run_command"]})),
        0 => describe(),
        1 => call(
            "replace_work_plan",
            json!({"objective":"Bounded research","execution_mode":"direct","actions":[{"action_key":"research","description":"Record evidence"}],"checks":["Findings recorded"]}),
        ),
        2 => review(),
        3 if mode == Mode::Scope => call(
            "write_file",
            json!({"path":"tasks/A/inside.txt","content":"complete in-scope content","overwrite":false,"create_parents":true}),
        ),
        4 if mode == Mode::Scope => call(
            "write_file",
            json!({"path":"outside.txt","content":"refused","overwrite":false}),
        ),
        5 if mode == Mode::Scope => call(
            "run_command",
            json!({"summary":"Create the two requested outputs","command":"printf workspace-change > outside-command.txt; printf scope-change > \"$BUTLER_ARTIFACTS_DIR/outside.txt\"","state_effect":"read_only"}),
        ),
        6 if mode == Mode::Scope => {
            disposition(body, &[json!({"action_key":"research","status":"done"})])
        }
        3 => call(
            "document_create",
            json!({"title":"Research evidence","body":FACTS}),
        ),
        4 => disposition(body, &[json!({"action_key":"research","status":"done"})]),
        _ => message(FACTS),
    }
}
fn review() -> Value {
    call(
        "record_work_review",
        json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
    )
}
fn disposition(body: &Value, updates: &[Value]) -> Value {
    let work = outputs(body)
        .iter()
        .find_map(|v| v["work"]["work_id"].as_str().map(str::to_owned))
        .unwrap_or_default();
    call(
        "record_work_disposition",
        json!({"work_id":work,"disposition":"completed","summary":FACTS,"action_updates":updates,"remaining_actions":[],"followups":[]}),
    )
}
pub(super) fn outputs(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v["output"].as_str())
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .map(|v| v["output"].clone())
        .collect()
}
fn call(name: &str, mut args: Value) -> Value {
    if name == "delegate_to_worker" && args.get("task").is_none() {
        args["task"] = json!({"scope":{"paths":[format!("tasks/{}", args["action_key"].as_str().unwrap_or("work"))]},"output":{"format":"text","fields":["summary"]}});
    }
    let (name, args) = if matches!(
        name,
        "document_create"
            | "output_publish"
            | "read_file"
            | "read_conversation_session"
            | "run_command"
    ) {
        (
            "tool_call",
            json!({"id":format!("native:{name}"),"arguments":args}),
        )
    } else {
        (name, args)
    };
    let mut call = json!({"type":"function_call","name":name});
    call["arguments"] = args;
    call
}
fn message(text: &str) -> Value {
    json!({"type":"message","text":text})
}

fn wire(item: &Value, id: &str) -> String {
    let item = if item["type"] == "function_call" {
        json!({"type":"function_call","id":id,"call_id":id,"name":item["name"],"arguments":item["arguments"].to_string(),"status":"completed"})
    } else {
        json!({"type":"message","id":id,"role":"assistant","status":"completed","content":[{"type":"output_text","text":item["text"],"annotations":[]}]})
    };
    let mut events = vec![
        json!({"type":"response.created","response":{"id":id,"status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":id,"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":id,"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":id,"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":id,"object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
