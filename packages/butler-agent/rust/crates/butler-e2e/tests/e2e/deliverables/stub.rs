//! Script selection lives entirely in the deterministic provider.
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    fmt::Write,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct Script {
    pub prompt: Mutex<String>,
    pub steps: Mutex<std::collections::VecDeque<Value>>,
    pub requests: Mutex<Vec<Value>>,
}
pub(super) async fn start()
-> Result<(String, Arc<Script>, tokio::task::JoinHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/codex", listener.local_addr()?);
    let script = Arc::new(Script::default());
    let router = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(script.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((url, script, server))
}
pub(super) fn call(name: &str, args: impl serde::Serialize) -> Value {
    let id = butler_e2e::e2e::nonce();
    let args = serde_json::to_value(args).unwrap();
    json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
}
pub(super) fn done() -> Value {
    json!({"type":"message","id":"answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]})
}
async fn reply(
    State(script): State<Arc<Script>>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let key = butler_e2e::e2e::matching::key("/codex/responses", &body, &Default::default());
    let selected = key.user_request == *script.prompt.lock().unwrap();
    script.requests.lock().unwrap().push(body.clone());
    let item = if selected {
        script
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(done)
    } else {
        done()
    };
    if item["name"] == "deliver_files" {
        assert_delivery_schema(&body);
    }
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"stub","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"stub","object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    let wire = events
        .into_iter()
        .enumerate()
        .fold(String::new(), |mut wire, (n, mut event)| {
            event["sequence_number"] = json!(n);
            write!(
                wire,
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
            .unwrap();
            wire
        });
    ([("content-type", "text/event-stream")], wire)
}

fn assert_delivery_schema(body: &Value) {
    use butler_runtime::capabilities::validate_native_arguments;
    let tool = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "deliver_files")
        .expect("deliver_files must be visible");
    let schema = &tool["parameters"];
    assert!(validate_native_arguments(&json!({"files":[{"path":"file"}]}), schema).is_ok());
    assert!(validate_native_arguments(&json!({"files":[]}), schema).is_err());
    assert!(
        validate_native_arguments(&json!({"files":vec![json!({"path":"file"});13]}), schema)
            .is_err()
    );
}
