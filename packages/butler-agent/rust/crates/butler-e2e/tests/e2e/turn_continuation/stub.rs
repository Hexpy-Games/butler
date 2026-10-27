use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const REQUEST: &str = "Calculate the total and report the result.";
#[derive(Clone, Copy)]
pub(crate) enum Mode {
    Progress,
    Empty,
    Reasoning,
    Commentary,
    CutCommentary,
    Approval,
    Question,
    Todo,
    Prose,
    JsonProse,
    ApprovalRecovery,
    FinalTools,
    FinalEmptyTools,
    Batched,
    ParallelFiles,
}
pub(crate) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub file_root: Mutex<String>,
    pub mode: Mode,
}

pub(super) async fn start(
    mode: Mode,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::new(vec![]),
        file_root: Mutex::new(String::new()),
        mode,
    });
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, script, server))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    let item = if key.user_request == REQUEST {
        let step = {
            let mut requests = script.requests.lock().unwrap();
            requests.push(body.clone());
            requests.len() - 1
        };
        match script.mode {
            Mode::FinalTools if step == 8 || step == 9 => call(
                &format!("forbidden-{step}"),
                "write_file",
                &json!({"path":"final-mutation.txt","content":"forbidden"}),
            ),
            Mode::FinalEmptyTools if step == 8 => message(""),
            Mode::FinalEmptyTools if step == 9 => call(
                "forbidden-9",
                "write_file",
                &json!({"path":"final-mutation.txt","content":"forbidden"}),
            ),
            Mode::Progress | Mode::FinalTools | Mode::FinalEmptyTools => progress(step, &body),
            Mode::ParallelFiles if step == 0 => json!(
                (0..3)
                    .map(|i| call(
                        &format!("lookup-{i}"),
                        "list_files",
                        &json!({"root":format!("{}/lookup-{i}", script.file_root.lock().unwrap())})
                    ))
                    .collect::<Vec<_>>()
            ),
            Mode::Batched => {
                super::super::token_cache::batched_reply(step, &body, progress, command, call)
            }
            Mode::Prose if step < 5 => {
                message("<tool_call>call: read_file {requests:[{path:\"source\"}]}</tool_call>")
            }
            Mode::JsonProse if step == 0 => message(
                "The total follows.\n\n:::read_file\n{\"requests\":[{\"path\":\"source\"}]}\n:::",
            ),
            Mode::ApprovalRecovery if step == 1 => command(true),
            Mode::Empty | Mode::ApprovalRecovery if step < 5 => message(""),
            Mode::Reasoning if step == 0 => {
                json!({"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"Need to calculate the result."}]})
            }
            Mode::CutCommentary if step == 0 => message("The total "),
            Mode::CutCommentary if step == 1 => {
                let mut item = message("Private progress.");
                item["phase"] = json!("commentary");
                item
            }
            Mode::CutCommentary => message("is 42."),
            Mode::Commentary if step == 0 => {
                let mut item = message("I am working on the total.");
                item["phase"] = json!("commentary");
                item
            }
            Mode::Question if step == 0 => call(
                "question",
                "ask_user",
                &json!({"questions":[{"id":"format","eyebrow":"Output","title":"Which format?","kind":"single","allow_custom":true,"options":[{"id":"brief","label":"Brief","recommended":true},{"id":"full","label":"Full"}]}]}),
            ),
            Mode::Approval if step == 0 => command(matches!(script.mode, Mode::Approval)),
            Mode::ParallelFiles
            | Mode::Empty
            | Mode::ApprovalRecovery
            | Mode::Prose
            | Mode::JsonProse
            | Mode::Approval
            | Mode::Question
            | Mode::Reasoning
            | Mode::Commentary => message("The total is 42."),
            Mode::Todo => match step {
                0 => call(
                    "todo",
                    "update_todo_list",
                    &json!({"todos":[{"content":"Calculate total","active_form":"Calculating total","status":"in_progress"}]}),
                ),
                1 => message("Progress updated. I will continue the calculation."),
                2 => command(false),
                3 => call(
                    "todo-done",
                    "update_todo_list",
                    &json!({"todos":[{"content":"Calculate total","active_form":"Calculating total","status":"completed"}]}),
                ),
                _ => message("The total is 42."),
            },
        }
    } else {
        message("{}")
    };
    let item = if matches!(script.mode, Mode::Approval | Mode::Question)
        && item["type"] == "function_call"
    {
        json!([message(super::paused_transcript::PREAMBLE), item])
    } else {
        item
    };
    let response = if matches!(script.mode, Mode::CutCommentary)
        && script.requests.lock().unwrap().len() == 1
    {
        cut_wire(&item)
    } else {
        wire(&item)
    };
    ([("content-type", "text/event-stream")], response).into_response()
}

fn cut_wire(item: &Value) -> String {
    wire(item)
        .lines()
        .map(|line| {
            let Some(raw) = line.strip_prefix("data: ") else {
                return line.replace("event: response.completed", "event: response.incomplete");
            };
            let mut event: Value = serde_json::from_str(raw).unwrap();
            if event["type"] == "response.completed" {
                event["type"] = json!("response.incomplete");
                event["response"]["status"] = json!("incomplete");
                event["response"]["incomplete_details"] = json!({"reason":"max_output_tokens"});
            }
            format!("data: {event}")
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn progress(step: usize, body: &Value) -> Value {
    match step {
        0 => call("start", "start_work", &json!({"objective":REQUEST})),
        1 => call(
            "plan",
            "replace_work_plan",
            &json!({"objective":REQUEST,"execution_mode":"direct","actions":[{"action_key":"calculate","description":"Calculate the total"}],"checks":["Correct total reported"]}),
        ),
        2 => call(
            "review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Plan covers the request"}),
        ),
        3 => call(
            "checkpoint",
            "record_work_checkpoint",
            &json!({"public_summary":"Calculation pending","action_updates":[{"action_key":"calculate","status":"active"}]}),
        ),
        4 => call(
            "open",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"open","summary":"Plan saved; calculation remains","action_updates":[],"remaining_actions":["calculate"],"next_condition":"Continue calculation","followups":[]}),
        ),
        5 => message("Progress saved; the calculation is still pending."),
        6 => command(false),
        7 => call(
            "complete",
            "record_work_disposition",
            &json!({"work_id":work_id(body),"disposition":"completed","summary":"Total verified","action_updates":[{"action_key":"calculate","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => message("The total is 42."),
    }
}
fn work_id(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter_map(|item| item["output"].as_str())
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .find_map(|output| {
            output
                .pointer("/output/work/work_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap()
}
fn command(approval: bool) -> Value {
    let command = match (butler_platform::command_sandbox::POSIX_SHELL, approval) {
        (true, false) => "printf '%s\\n' $((19 + 23))",
        (true, true) => "printf '%s\\n' $((19 + 23)) > total.txt",
        (false, false) => "cmd.exe /d /c echo 42",
        (false, true) => "cmd.exe /d /c \"echo 42>total.txt\"",
    };
    call(
        "calculate",
        "run_command",
        &json!({"command":command,"summary":"Calculate total","state_effect":if approval { "mutation" } else { "read_only" },"timeout_ms":30000}),
    )
}
fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
fn wire(item: &Value) -> String {
    super::super::token_cache::wire(item)
}
