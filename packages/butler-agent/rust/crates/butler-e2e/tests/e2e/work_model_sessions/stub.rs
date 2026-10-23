//! Provider barriers keep real workers running until the user-flow assertions finish.
use super::super::{access_tiers::stub::call, work_model_script as native};
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub release: Vec<Semaphore>,
    pub dispatch_more: Semaphore,
    workers: usize,
    here: bool,
}
pub(super) async fn start(
    workers: usize,
    here: bool,
) -> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let script = Arc::new(Script {
        requests: Mutex::default(),
        dispatch_more: Semaphore::new(0),
        release: (0..=workers).map(|_| Semaphore::new(0)).collect(),
        workers,
        here,
    });
    let url = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .route("/codex/responses", post(reply))
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
    let request =
        butler_e2e::e2e::matching::key("/codex/responses", &body, &Default::default()).user_request;
    let step = native::outputs(&body).len();
    script.requests.lock().unwrap().push(body.clone());
    let item = if request.starts_with("role: worker") {
        let index = request
            .split("Report piece ")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse::<usize>()
            .unwrap();
        if step == 0 {
            script.release[index].acquire().await.unwrap().forget();
        }
        worker(step, index, &body)
    } else if request.starts_with("role: steward") {
        steward(step, script.workers, &body)
    } else if request == JOB && script.here {
        if step == 0 {
            call(
                "bootstrap",
                "work_apply",
                &native::bootstrap(JOB, &["Reports verified"]),
            )
        } else {
            message("The Task is running here.")
        }
    } else if request == DISPATCH {
        if step < script.workers {
            dispatch(step)
        } else if step == script.workers && script.here {
            script.dispatch_more.acquire().await.unwrap().forget();
            dispatch(step)
        } else {
            message("The reports are assigned.")
        }
    } else if request == JOB {
        match step {
            0 => call(
                "bootstrap",
                "work_apply",
                &native::bootstrap(JOB, &["Reports verified"]),
            ),
            1 => call(
                "steward",
                "delegate_to_steward",
                &json!({"request":"Coordinate the bounded reports."}),
            ),
            _ => message("The reports are assigned."),
        }
    } else {
        message("The worker result was received.")
    };
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}
fn steward(step: usize, workers: usize, body: &Value) -> Value {
    match step {
        0 => call("tasks", "work_read", &json!({"view":"tasks"})),
        1 => call(
            "task",
            "work_read",
            &json!({"view":"task","task_id":native::task_id(body)}),
        ),
        n if n < workers + 2 => dispatch(n - 2),
        _ => call("wait", "wait_for_worker", &json!({})),
    }
}
fn dispatch(index: usize) -> Value {
    call(
        &format!("worker_{index}"),
        "delegate_to_worker",
        &json!({
        "action_key":format!("report-{index}"),"objective":format!("Report piece {index}"),
        "acceptance_criteria":["Report checked"],"implementation_brief":"Inspect the assigned report and return its evidence."}),
    )
}
fn worker(step: usize, index: usize, body: &Value) -> Value {
    match step {
        0 => call("tasks", "work_read", &json!({"view":"tasks"})),
        1 => call(
            "task",
            "work_read",
            &json!({"view":"task","task_id":native::task_id(body)}),
        ),
        2 => {
            let view = native::view(body);
            let title = format!("Report piece {index}");
            let part = view["parts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["title"] == title)
                .unwrap();
            call(
                "submit",
                "work_apply",
                &native::apply(
                    body,
                    json!([{
                "op":"task.submit","task_id":native::task_id(body),"part_id":part["id"],
                "result_refs":["Report inspected"],"evidence_refs":["Report checked"]}]),
                ),
            )
        }
        _ => message("Report inspected and checked."),
    }
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"done","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]})
}
