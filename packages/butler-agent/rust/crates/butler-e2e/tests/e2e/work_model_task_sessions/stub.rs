//! A paused provider turn lets user operations race a real child session.
use super::super::{access_tiers::stub::call, work_model_script as native};
use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub(super) struct Script {
    pub requests: Mutex<Vec<Value>>,
    pub task: Mutex<String>,
    pub child_ready: Semaphore,
    pub release: Semaphore,
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let script = Arc::new(Script {
        requests: Mutex::default(),
        task: Mutex::default(),
        child_ready: Semaphore::new(0),
        release: Semaphore::new(0),
    });
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
    let out = native::outputs(&body);
    script.requests.lock().unwrap().push(body.clone());
    let item = if request == PLAN || request == HERE {
        if out.is_empty() {
            let here = request == HERE;
            let mut ops = json!([{"op":"work.create_light","run_here":here,"goal":"Prepare the three requested pieces","done_criteria":["Pieces prepared","Pieces checked"],"tasks":[
                [{"key":"a","title":"초안","description":"Prepare the first piece"}],
                [{"key":"b","title":"검토","description":"Check the first piece"}],
                [{"key":"c","title":"보고","description":"Report the checked pieces"}]
            ]}]);
            if here {
                ops.as_array_mut()
                    .unwrap()
                    .extend([json!({"op":"task.start","task_id":"@a"})]);
            }
            call(
                "plan",
                "work_apply",
                &json!({"reason":"Plan the requested pieces","operations":ops}),
            )
        } else if request == HERE && out.len() == 1 {
            call(
                "read",
                "work_read",
                &json!({"view":"task","task_id":out[0]["keys"]["a"]}),
            )
        } else if request == HERE && out.len() == 2 {
            call(
                "block",
                "work_apply",
                &native::block(&body, "First piece started here; waiting for input"),
            )
        } else {
            message("The pieces are planned.")
        }
    } else if request.starts_with("role: steward") {
        match out.len() {
            0 => call("tasks", "work_read", &json!({"view":"tasks"})),
            1 => call(
                "task",
                "work_read",
                &json!({"view":"task","task_id":native::task_id(&body)}),
            ),
            _ => {
                script.child_ready.add_permits(1);
                script.release.acquire().await.unwrap().forget();
                message("The first piece is prepared; checking remains.")
            }
        }
    } else if request == TAKE {
        if out.is_empty() {
            let task = script.task.lock().unwrap().clone();
            call(
                "take",
                "work_apply",
                &json!({"reason":"Do the requested piece here","operations":[{"op":"task.start","task_id":task}]}),
            )
        } else {
            message("Choose where to continue this piece.")
        }
    } else if request.starts_with("Continue Task ") {
        match out.len() {
            0 => call(
                "task",
                "work_read",
                &json!({"view":"task","task_id":script.task.lock().unwrap().clone()}),
            ),
            1 => call(
                "start",
                "work_apply",
                &native::apply(
                    &body,
                    json!([{"op":"task.start","task_id":native::task_id(&body)}]),
                ),
            ),
            2 => call(
                "checkpoint",
                "work_apply",
                &native::block(&body, "Checkpoint continued here; waiting for input"),
            ),
            _ => message("Continued from the saved checkpoint."),
        }
    } else {
        message("The update is recorded.")
    };
    (
        [("content-type", "text/event-stream")],
        super::super::token_cache::wire(&item),
    )
        .into_response()
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}
