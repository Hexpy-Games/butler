//! Deterministic provider: session work without a plan, followed by file effects.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, matching, sanitize::Placeholders};
use serde_json::{Value, json};
pub(super) const REQUEST: &str =
    "Track this work, write alpha to integrity.txt, then edit it to beta.";

pub(super) async fn start(
    path: String,
    planned: bool,
    tracked: bool,
) -> Result<(String, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .route_layer(axum::middleware::from_fn(
            butler_e2e::e2e::chatgpt_wire::validate,
        ))
        .with_state((path, planned, tracked));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, server))
}

async fn reply(
    State((path, planned, tracked)): State<(String, bool, bool)>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let key = matching::key("/v1/responses", &body, &Placeholders::default());
    let n = body["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["type"] == "function_call_output"
                && v["call_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("integrity-"))
        })
        .count();
    let item = if key.user_request == REQUEST {
        if planned && n == 1 {
            call(
                n,
                "replace_work_plan",
                &json!({"objective":REQUEST,"execution_mode":"direct",
                "actions":[{"action_key":"edit","description":"Write and edit the file"}],
                "checks":["File contains beta"]}),
            )
        } else if planned && n == 2 {
            call(
                n,
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept",
                "summary":"Plan covers the requested edit"}),
            )
        } else {
            let step = if !tracked {
                n + 1
            } else if planned && n > 2 {
                n - 2
            } else {
                n
            };
            effect(step, n, &path, &body, tracked, planned)
        }
    } else {
        message("{}")
    };
    (
        [("content-type", "text/event-stream")],
        super::super::super::token_cache::wire(&item),
    )
        .into_response()
}
fn effect(step: usize, n: usize, path: &str, body: &Value, tracked: bool, planned: bool) -> Value {
    match step {
        0 => call(n, "start_work", &json!({"objective":REQUEST})),
        1 => call(n, "write_file", &json!({"path":path,"content":"alpha"})),
        2 => call(
            n,
            "edit_file",
            &json!({"path":path,"old_text":"alpha","new_text":"beta"}),
        ),
        3 if tracked => call(
            n,
            "record_work_disposition",
            &json!({
                "work_id": work_id(body).expect("start_work returned its bound Work"),
                "disposition":"completed", "summary":"Wrote and edited the file.",
                "action_updates":if planned { json!([{"action_key":"edit","status":"done"}]) } else { json!([]) },
                "remaining_actions":[], "followups":[]
            }),
        ),
        _ => message("Done."),
    }
}

fn call(n: usize, name: &str, args: &Value) -> Value {
    json!({"type":"function_call","id":format!("fc_integrity-{n}"),"call_id":format!("integrity-{n}"),"name":name,"arguments":args.to_string(),"status":"completed"})
}
fn message(text: &str) -> Value {
    json!({"type":"message","id":"msg_integrity","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn work_id(body: &Value) -> Option<String> {
    body["input"]
        .as_array()?
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .find_map(|item| {
            let output = &item["output"];
            let text = output.as_str().or_else(|| {
                output
                    .as_array()?
                    .iter()
                    .find(|part| part["type"] == "input_text")?["text"]
                    .as_str()
            })?;
            let value: Value = serde_json::from_str(text).ok()?;
            let result = value.get("output").unwrap_or(&value);
            result["work"]["work_id"].as_str().map(str::to_owned)
        })
}
