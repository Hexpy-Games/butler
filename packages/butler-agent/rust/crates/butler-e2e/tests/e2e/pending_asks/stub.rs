use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use std::sync::{Arc, Mutex};

pub(super) const ASK: &str = "Save a question for my next step and finish this reply.";
pub(super) const APPROVE: &str = "Read the files in the review directory.";
#[derive(Default)]
pub(super) struct Script {
    pub root: Mutex<String>,
    pub requests: Mutex<Vec<Value>>,
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = format!("http://{}/v1", listener.local_addr()?);
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
    Ok((address, script, server))
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    script.requests.lock().unwrap().push(body.clone());
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    let item = match key.user_request.as_str() {
        ASK if key.round.is_empty() => {
            let mut args = crate::ask_user::stub::questions();
            args["wait"] = json!(false);
            call("ask", "ask_user", &args)
        }
        APPROVE if key.round.is_empty() => call(
            "files",
            "list_files",
            &json!({"root":*script.root.lock().unwrap()}),
        ),
        _ => {
            json!({"type":"message","id":"msg_done","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Saved. The reply is complete.","annotations":[]}]})
        }
    };
    let response = crate::ask_user::stub::response(&item);
    (
        [("content-type", "text/event-stream")],
        response
            .chunks
            .iter()
            .map(|c| c.text.as_str())
            .collect::<String>(),
    )
        .into_response()
}
fn call(id: &str, name: &str, arguments: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_{id}"),"call_id":format!("call_{id}"),"name":name,"arguments":arguments.to_string(),"status":"completed"})
}
