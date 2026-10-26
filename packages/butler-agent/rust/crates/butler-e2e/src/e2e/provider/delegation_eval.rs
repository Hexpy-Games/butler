//! Owner-run evaluations: raw-byte forwarding with local Butler responses.
use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
pub mod wire;

/// No request headers or credentials are retained in evaluation results.
pub struct Evaluation {
    upstream: String,
    client: reqwest::Client,
    steward: bool,
    max_rounds: usize,
    rounds: Mutex<usize>,
    pub limited: std::sync::atomic::AtomicBool,
    pub samples: Mutex<Vec<Value>>,
    pub local_text: Mutex<String>,
    pub delegation: Mutex<std::collections::VecDeque<Value>>,
    pub local_answers: AtomicUsize,
    pub local_calls: Mutex<Vec<String>>,
    pub inflight: AtomicUsize,
    pub armed: std::sync::atomic::AtomicBool,
}

impl Provider {
    /// Uses the recorder's transport, but a replay state: finish/drop cannot
    /// write a cassette. The evaluated model output never reaches Butler.
    pub async fn delegation_evaluation(
        upstream: String,
        steward: bool,
        max_rounds: usize,
    ) -> Result<(Self, Arc<Evaluation>), HarnessError> {
        if std::env::var("BUTLER_E2E_DELEGATION_EVAL").as_deref() != Ok("1") {
            return Err(harness_error(
                "delegation evaluation requires explicit opt-in",
            ));
        }
        let cassette = Cassette {
            scenario: "delegation-eval".into(),
            meta: Meta::default(),
            exchanges: vec![],
        };
        let mut provider = Self::replay(cassette, Placeholders::default()).await?;
        provider.server.abort();
        let eval = Arc::new(Evaluation {
            upstream,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()?,
            steward,
            max_rounds,
            rounds: Mutex::new(0),
            limited: false.into(),
            samples: Mutex::new(vec![]),
            local_text: Mutex::new("Done.".into()),
            delegation: Mutex::new(std::collections::VecDeque::new()),
            local_answers: AtomicUsize::new(0),
            local_calls: Mutex::new(vec![]),
            inflight: AtomicUsize::new(0),
            armed: false.into(),
        });
        let socket = TcpListener::bind("127.0.0.1:0").await?;
        provider.base_url = format!("http://{}", socket.local_addr()?);
        let state = provider.state.clone();
        let shared = eval.clone();
        let app = axum::Router::new().fallback(move |request: Request<Body>| {
            let (state, eval) = (state.clone(), shared.clone());
            async move { eval.handle(state, request).await }
        });
        provider.server = tokio::spawn(async move {
            let _ = axum::serve(socket, app).await;
        });
        Ok((provider, eval))
    }
}

impl Evaluation {
    pub fn snapshot(&self) -> Vec<Value> {
        lock(&self.samples).clone()
    }

    async fn handle(&self, state: Arc<State>, request: Request<Body>) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let path = parts.uri.path().to_owned();
        if parts.method == axum::http::Method::GET {
            // Discovery is metadata only; it cannot start a model round.
            return budget::forward_models(&state, &self.upstream, &self.client, &parts.headers)
                .await;
        }
        let Ok(bytes) = axum::body::to_bytes(body, 64 * 1024 * 1024).await else {
            return plain(400, "invalid eval request");
        };
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let key = matching::key(&path, &value, &Placeholders::default());
        let child = wire::child(&value);
        let tools = value["tools"].as_array().is_some_and(|v| !v.is_empty());
        let tools = tools
            && !memory::matches(&value)
            && !is_title_request(&value)
            && !is_smart_group_request(&value);
        let forward = tools
            && if self.steward {
                child
            } else {
                self.armed.swap(false, Ordering::SeqCst)
            };
        if !forward {
            return self.local_answer(&path, &value, tools && self.steward && !child);
        }
        if !self.admit() {
            return plain(429, "evaluation model round limit reached");
        }
        let response = self.forward(state, parts, bytes, value, key).await;
        self.inflight.fetch_sub(1, Ordering::SeqCst);
        response
    }

    fn admit(&self) -> bool {
        let mut rounds = lock(&self.rounds);
        if *rounds >= self.max_rounds {
            self.limited.store(true, Ordering::SeqCst);
            return false;
        }
        *rounds += 1;
        self.inflight.fetch_add(1, Ordering::SeqCst);
        true
    }

    fn local_answer(&self, path: &str, value: &Value, parent: bool) -> Response<Body> {
        self.local_answers.fetch_add(1, Ordering::SeqCst);
        let call = if parent {
            lock(&self.delegation).pop_front()
        } else {
            None
        };
        if let Some(call) = &call {
            lock(&self.local_calls).push(call["name"].as_str().unwrap_or("").to_owned());
        }
        wire::answer(
            path,
            call,
            &lock(&self.local_text),
            value["model"].as_str().unwrap_or(""),
        )
    }

    pub fn upstream_rounds(&self) -> usize {
        *lock(&self.rounds)
    }

    async fn forward(
        &self,
        state: Arc<State>,
        parts: axum::http::request::Parts,
        bytes: bytes::Bytes,
        value: Value,
        key: cassette::MatchKey,
    ) -> Response<Body> {
        let path = parts.uri.path().to_owned();
        let digest = super::super::sha256_hex(&bytes);
        let length = bytes.len();
        let response = record(
            &state,
            &self.upstream,
            &self.client,
            &parts.method,
            &parts.headers,
            path.clone(),
            key,
            bytes,
        )
        .await;
        let (parts, body) = response.into_parts();
        let Ok(body) = axum::body::to_bytes(body, 64 * 1024 * 1024).await else {
            return plain(502, "evaluation upstream stream failed");
        };
        let mut sample = wire::parse(&body);
        sample["http_status"] = json!(parts.status.as_u16());
        sample["request_sha256"] = json!(digest);
        sample["request_bytes"] = json!(length);
        let prompt = format!(
            "{}{}{}",
            value["instructions"].as_str().unwrap_or(""),
            value["system"],
            value["tools"]
        );
        if let Ok(tokenizer) = tiktoken_rs::o200k_base() {
            sample["instruction_tool_tokens_o200k_estimate"] =
                json!(tokenizer.encode_ordinary(&prompt).len());
        }
        let model = value["model"].as_str().unwrap_or("").to_owned();
        sample["request"] = value;
        lock(&self.samples).push(sample);
        // The recorder retains only transient sanitized exchanges; never publish them.
        lock(&state.recorded).clear();
        if self.steward {
            Response::from_parts(parts, Body::from(body))
        } else {
            wire::answer(&path, None, &lock(&self.local_text), &model)
        }
    }
}
