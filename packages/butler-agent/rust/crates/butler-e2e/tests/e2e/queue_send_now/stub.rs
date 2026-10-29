//! A local scripted Responses provider with explicit reply gates.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use butler_e2e::e2e::{HarnessError, provider::Script, scenario::Setup};
use serde_json::{Value, json};
use std::{
    fmt::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

pub(super) struct Request {
    pub body: Value,
    reply: oneshot::Sender<Value>,
}
impl Request {
    pub(super) fn answer(self) {
        self.reply
            .send(json!({"id":"answer","type":"message","role":"assistant",
            "phase":"final_answer","status":"completed",
            "content":[{"type":"output_text","text":"Done.","annotations":[]}]}))
            .ok();
    }
    pub(super) fn command(self) {
        self.reply
            .send(
                json!({"id":"command","call_id":"command","type":"function_call",
            "name":"run_command","status":"completed",
            "arguments":json!({"command":"printf approved","summary":"Print","state_effect":"read_only","cwd":"."}).to_string()}),
            )
            .ok();
    }
}
#[derive(Clone)]
struct Endpoint {
    requests: mpsc::UnboundedSender<Request>,
    fallback: Arc<Mutex<String>>,
    client: reqwest::Client,
}

pub(super) struct Stub {
    requests: mpsc::UnboundedReceiver<Request>,
    server: tokio::task::JoinHandle<()>,
    fallback: Arc<Mutex<String>>,
}
impl Drop for Stub {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Stub {
    pub(super) async fn setup() -> Result<(Self, Setup), HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/v1", listener.local_addr()?);
        let (tx, requests) = mpsc::unbounded_channel();
        let fallback = Arc::new(Mutex::new(String::new()));
        let router = Router::new()
            .route("/v1/responses", post(reply))
            .route_layer(axum::middleware::from_fn(
                butler_e2e::e2e::chatgpt_wire::validate,
            ))
            .with_state(Endpoint {
                requests: tx,
                fallback: fallback.clone(),
                client: reqwest::Client::new(),
            });
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let setup = Setup::new("QUEUE-SEND-NOW")?
            .synthetic(Script {
                rounds: 0,
                path_for: Box::new(|_| String::new()),
                final_text: "Done.".into(),
            })
            .env("BUTLER_CHATGPT_API_BASE_URL", url);
        Ok((
            Self {
                requests,
                server,
                fallback,
            },
            setup,
        ))
    }
    pub(super) fn attach(
        &self,
        scenario: &butler_e2e::e2e::scenario::Scenario,
    ) -> Result<(), HarnessError> {
        *self.fallback.lock().unwrap() = scenario.provider()?.base_url.clone();
        Ok(())
    }
    pub(super) async fn next(&mut self) -> Request {
        tokio::time::timeout(Duration::from_secs(30), self.requests.recv())
            .await
            .expect("provider request deadline")
            .expect("provider closed")
    }
}
async fn reply(
    State(endpoint): State<Endpoint>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    // Keep the harness's normal background title, classification and memory
    // responders; only interactive requests need an explicit reply gate.
    if body["tools"].as_array().is_none_or(Vec::is_empty) {
        let base = endpoint.fallback.lock().unwrap().clone();
        let response = endpoint
            .client
            .post(format!("{base}/v1/responses"))
            .header(
                "authorization",
                headers.get("authorization").unwrap().clone(),
            )
            .json(&body)
            .send()
            .await
            .unwrap();
        eprintln!(
            "send-now background response: format={}",
            body["text"]["format"]["name"]
        );
        return (
            [("content-type", "text/event-stream")],
            response.text().await.unwrap(),
        )
            .into_response();
    }
    let (reply, receiver) = oneshot::channel();
    endpoint.requests.send(Request { body, reply }).unwrap();
    let item = receiver.await.unwrap_or_else(|_| json!({}));
    let events = [
        json!({"type":"response.created","response":{"id":"stub","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        if item["type"] == "message" {
            json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,
                "content_index":0,"delta":item["content"][0]["text"]})
        } else {
            json!({"type":"response.function_call_arguments.done","item_id":item["id"],
                "output_index":0,"arguments":item["arguments"]})
        },
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"stub","object":"response",
            "status":"completed","model":"gpt-6-luna","output":[item],
            "usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
    ];
    let wire =
        events
            .into_iter()
            .enumerate()
            .fold(String::new(), |mut wire, (index, mut event)| {
                event["sequence_number"] = json!(index);
                write!(
                    wire,
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
                .unwrap();
                wire
            });
    ([("content-type", "text/event-stream")], wire).into_response()
}
