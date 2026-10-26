//! Local fake upstream: deterministic answers, records raw-body digests.
use axum::{Router, body::Body, http::Request};
use butler_e2e::e2e::{HarnessError, provider::delegation_eval::wire};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
pub(super) struct Upstream {
    pub base: String,
    seen: Arc<Mutex<Vec<String>>>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Upstream {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Upstream {
    pub(super) async fn start(first: bool, case: &Value) -> Result<Self, HarnessError> {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", socket.local_addr()?);
        let seen = Arc::new(Mutex::new(vec![]));
        let capture = seen.clone();
        let delegate = case["label"] == "delegate";
        let app = Router::new().fallback(move |req: Request<Body>| {
            let seen = capture.clone();
            async move {
                let path = req.uri().path().to_owned();
                if req.method() == axum::http::Method::GET {
                    return axum::http::Response::builder().header("content-type","application/json")
                        .body(Body::from(json!({"models":[{"slug":"gpt-6-luna","display_name":"GPT 6 Luna","visibility":"list"}]}).to_string())).unwrap();
                }
                let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024 * 1024)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                let mut log = seen.lock().unwrap();
                let step = log.len();
                log.push(format!("{:x}", Sha256::digest(&bytes)));
                drop(log);
                let call = if first {
                    delegate.then(|| wire::call("delegate_to_steward", &json!({"request":"test"})))
                } else {
                    steward(step, &body)
                };
                wire::answer(&path, call, "Finished.", body["model"].as_str().unwrap())
            }
        });
        let server = tokio::spawn(async move {
            let _ = axum::serve(socket, app).await;
        });
        Ok(Self { base, seen, server })
    }
    pub(super) fn verify(&self, samples: &[Value]) {
        let seen = self.seen.lock().unwrap();
        assert!(!samples.is_empty(), "no upstream model request captured");
        assert_eq!(seen.len(), samples.len(), "unexpected upstream calls");
        for (digest, sample) in seen.iter().zip(samples) {
            assert_eq!(
                digest,
                sample["request_sha256"].as_str().unwrap(),
                "raw bytes changed in forwarding"
            );
            assert_eq!(sample["complete"], true);
            assert_eq!(sample["http_status"], 200);
        }
    }
}
fn steward(step: usize, body: &Value) -> Option<Value> {
    let work = work_id(body).unwrap_or_default();
    let (name, args) = match step {
        // Attempt before review: must be refused and must not create this file.
        0 => (
            "write_file",
            json!({"path":"premature.txt","content":"must not exist"}),
        ),
        1 => (
            "replace_work_plan",
            json!({"objective":"Fix greeting","execution_mode":"direct",
            "actions":[{"action_key":"fix","description":"Fix greeting","dependency_keys":[]}],"checks":["greeting corrected"]}),
        ),
        2 => (
            "record_work_review",
            json!({"subject":"plan","verdict":"accept","summary":"Plan ready"}),
        ),
        3 => (
            "write_file",
            json!({"path":"greet.py","content":"def greet(name):\n    return 'Hello, ' + name\n"}),
        ),
        4 => (
            "record_work_review",
            json!({"subject":"result","verdict":"accept","summary":"Greeting corrected"}),
        ),
        5 => (
            "record_work_disposition",
            json!({"work_id":work,"disposition":"completed","summary":"Greeting corrected",
            "action_updates":[{"action_key":"fix","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => return None,
    };
    let mut call = wire::call(name, &args);
    call["id"] = json!(format!("fc_eval_{step}"));
    call["call_id"] = json!(format!("call_eval_{step}"));
    Some(call)
}
fn work_id(v: &Value) -> Option<String> {
    if let Some(id) = v["work_id"].as_str() {
        return Some(id.into());
    }
    match v {
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|v| work_id(&v)),
        Value::Object(o) => o.values().find_map(work_id),
        Value::Array(a) => a.iter().find_map(work_id),
        _ => None,
    }
}
