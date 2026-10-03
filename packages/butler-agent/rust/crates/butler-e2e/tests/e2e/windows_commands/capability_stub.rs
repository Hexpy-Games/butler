//! Deterministic tool cases through model rounds, Work and durable approval.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) const PROMPT: &str = "Windows 기본 파일 작업을 실행해줘";
pub(super) const DELEGATE_PROMPT: &str = "Steward에게 파일 작성을 위임해줘";

#[derive(Clone)]
pub(super) struct Case {
    pub tool: &'static str,
    pub args: Value,
    pub refused: bool,
}

pub(super) struct Script {
    pub case: Mutex<Case>,
    step: Mutex<usize>,
    child_step: Mutex<usize>,
    pub(super) delegated: AtomicBool,
    sent: Mutex<Option<Instant>>,
    pub result: Mutex<Option<(Value, Duration)>>,
}

impl Script {
    pub(super) fn select(&self, case: Case) {
        *self.case.lock().unwrap() = case;
        *self.step.lock().unwrap() = 0;
        *self.sent.lock().unwrap() = None;
        *self.result.lock().unwrap() = None;
    }
}

pub(super) async fn start(
    case: Case,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script {
        case: Mutex::new(case),
        step: Mutex::new(0),
        child_step: Mutex::new(1),
        delegated: AtomicBool::new(false),
        sent: Mutex::new(None),
        result: Mutex::new(None),
    });
    let router = Router::new()
        .route("/codex/responses", post(reply))
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
    let delegated = script.delegated.load(Ordering::SeqCst);
    let key = butler_e2e::e2e::matching::key(
        "/codex/responses",
        &body,
        &butler_e2e::e2e::sanitize::Placeholders::default(),
    );
    let child = key.user_request.starts_with("role: steward");
    if !child && key.user_request != PROMPT && key.user_request != DELEGATE_PROMPT {
        return (
            [("content-type", "text/event-stream")],
            super::stub::response(&message("{}")).body(),
        )
            .into_response();
    }
    let counter = if delegated && child {
        &script.child_step
    } else {
        &script.step
    };
    let step = {
        let mut s = counter.lock().unwrap();
        let step = *s;
        *s += 1;
        step
    };
    if delegated && !child {
        let item = parent(step);
        return (
            [("content-type", "text/event-stream")],
            super::stub::response(&item).body(),
        )
            .into_response();
    }
    let case = script.case.lock().unwrap().clone();
    let outputs = super::observation_stub::outputs(&body);
    let objective = format!("Verify {} {}", case.tool, case.args);
    if step == 4 {
        let output = outputs.last().expect("tool result").clone();
        let elapsed = script.sent.lock().unwrap().unwrap().elapsed();
        *script.result.lock().unwrap() = Some((output, elapsed));
    }
    let item = match step {
        0 => call("start", "start_work", &json!({"objective":objective})),
        1 => call(
            "plan",
            "replace_work_plan",
            &json!({"objective":objective,
            "execution_mode":"direct","actions":[action(&case)],
            "checks":["Complete result within the latency budget"]}),
        ),
        2 => call(
            "review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":objective}),
        ),
        3 => {
            *script.sent.lock().unwrap() = Some(Instant::now());
            call("operation", case.tool, &case.args)
        }
        4 => {
            let work = outputs
                .iter()
                .find_map(|v| v["work"]["work_id"].as_str())
                .unwrap();
            call(
                "close",
                "record_work_disposition",
                &json!({"work_id":work,"disposition":"completed",
                "summary":objective,"action_updates":[{"action_key":"basic","status":"done"}],
                "remaining_actions":[],"followups":[]}),
            )
        }
        _ => message("기본 작업 확인 완료"),
    };
    (
        [("content-type", "text/event-stream")],
        super::stub::response(&item).body(),
    )
        .into_response()
}

fn action(case: &Case) -> Value {
    let mut action = json!({"action_key":"basic","description":"Run the exact test operation"});
    if matches!(case.tool, "write_file" | "edit_file" | "run_command") {
        let target = if case.tool == "run_command" {
            format!(
                "workspace-command:{}",
                case.args["cwd"].as_str().unwrap_or(".")
            )
        } else {
            format!("workspace:{}", case.args["path"].as_str().unwrap())
        };
        action["effect"] = json!({"capability":case.tool,"target":target});
    }
    action
}

fn call(id: &str, name: &str, args: &Value) -> Value {
    let id = format!("{id}-{}", uuid::Uuid::new_v4());
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),
        "name":name,"arguments":args.to_string(),"status":"completed"})
}

fn parent(step: usize) -> Value {
    match step {
        0 => call(
            "parent-start",
            "start_work",
            &json!({"objective":"Delegate writing a file"}),
        ),
        1 => call(
            "parent-plan",
            "replace_work_plan",
            &json!({"objective":"Delegate writing a file",
            "execution_mode":"steward","actions":[{"action_key":"basic","description":"Write the test file"}],
            "checks":["File exists after user approval"]}),
        ),
        2 => call(
            "parent-review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
        ),
        3 => call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":"Write Downloads/위임 파일.txt with the exact approved content",
            "safe_title":"파일 작성"}),
        ),
        _ => message("위임 작업 확인"),
    }
}

fn message(text: &str) -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]})
}
