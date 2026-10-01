//! Loopback stand-ins for the servers first-run setup (#230) talks to, each
//! recording what it was asked:
//!
//! - [`FakeServer::local_models`]: a local model server with Ollama's
//!   `GET /api/tags`, LM Studio's `GET /v1/models` and OpenAI-compatible
//!   `POST /v1/chat/completions` (streamed or not).
//! - [`FakeServer::provider_models`]: a provider's `GET /v1/models` that
//!   checks the API key (OpenAI bearer or Anthropic `x-api-key`).
//! - [`FakeServer::oauth_token`]: an OAuth token endpoint.
//!
//! Provenance. Every body is a vendor's documented example or follows the
//! documented shape; values marked `synthetic` are made up for a case no
//! document shows. Nothing here is a recording: no local model server was
//! available on the build hosts.
//!
//! - Ollama `GET /api/tags`: "List Local Models",
//!   <https://github.com/ollama/ollama/blob/7af393188defd52d370464de0d2064649cab9b41/docs/api.md#list-local-models>;
//!   streaming on `/v1/chat/completions`:
//!   <https://github.com/ollama/ollama/blob/c1737589973d5cefd676ef16eb43835663540035/docs/api/openai-compatibility.mdx>.
//! - LM Studio `GET /v1/models` (no body example:
//!   <https://github.com/lmstudio-ai/docs/blob/d712bc9064b372b7974d14a94a43ed0c3ae36ec9/1_developer/3_openai-compat/models.md>)
//!   mirrors OpenAI's list: <https://platform.openai.com/docs/api-reference/models/list>.
//! - Chat completions: the object
//!   <https://platform.openai.com/docs/api-reference/chat/object> and its
//!   streamed chunks <https://platform.openai.com/docs/api-reference/chat-streaming/streaming>.
//! - OpenAI errors (`invalid_api_key`, `insufficient_quota`):
//!   <https://platform.openai.com/docs/guides/error-codes>.
//! - Anthropic `GET /v1/models` <https://docs.anthropic.com/en/api/models-list>
//!   and errors <https://docs.anthropic.com/en/api/errors>.
//! - OAuth token response: RFC 6749 section 5.1
//!   <https://www.rfc-editor.org/rfc/rfc6749#section-5.1> with the OpenID
//!   `id_token` <https://openid.net/specs/openid-connect-core-1_0.html#TokenResponse>;
//!   the ChatGPT claims (`email`, `https://api.openai.com/auth`
//!   `chatgpt_account_id`) as the Codex CLI reads them:
//!   <https://github.com/openai/codex/blob/f326857cf405fb254cf6c8f38766daff074fca6e/codex-rs/login/src/token_data.rs>.

use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, Response, StatusCode};
use futures_util::stream;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::HarnessError;

/// The model the local server lists first and answers as.
pub const LOCAL_MODEL: &str = "llama3.2:latest";
/// Keys the provider stand-in accepts or refuses.
pub const GOOD_KEY: &str = "sk-e2e-good-0001";
pub const QUOTA_KEY: &str = "sk-e2e-quota-0002";
/// The model Anthropic's documented list example names.
pub const ANTHROPIC_MODEL: &str = "claude-3-7-sonnet-20250219";
/// The account the OAuth stand-in signs in (synthetic).
pub const OAUTH_EMAIL: &str = "e2e-user@example.com";
pub const OAUTH_ACCOUNT_ID: &str = "e2e-account-0001";

/// How the local server answers a chat completion.
#[derive(Clone, Debug)]
pub struct ChatBehavior {
    pub answer: String,
    /// Refuse `stream: true` with HTTP 400, as servers without streaming do.
    pub refuse_stream: bool,
    /// Delay before each streamed chunk.
    pub chunk_delay: Duration,
    /// End streams after the finish reason, without `[DONE]` (synthetic:
    /// some OpenAI-compatible servers do).
    pub omit_done: bool,
    /// Cut the first streamed answer after its first words, with no finish
    /// reason (synthetic: a dropped connection); later ones are whole.
    pub cut_first_stream: bool,
    /// Wait this long before answering a streamed request after the first
    /// (a slow retry the test can stop the turn during).
    pub hold_later_streams: Duration,
}

impl Default for ChatBehavior {
    fn default() -> Self {
        Self {
            answer: "Local models stream their answers word by word.".into(),
            refuse_stream: false,
            chunk_delay: Duration::from_millis(150),
            omit_done: false,
            cut_first_stream: false,
            hold_later_streams: Duration::ZERO,
        }
    }
}

/// How one streamed answer ends.
#[derive(Clone, Copy)]
enum StreamEnd {
    Done,
    FinishOnly,
    Cut,
}

#[derive(Clone, Copy)]
enum Kind {
    LocalModels,
    ProviderModels,
    OauthToken,
}

/// One request as the stand-in saw it.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HeaderMap,
    pub body: String,
}

struct State {
    kind: Kind,
    chat: ChatBehavior,
    seen: Mutex<Vec<Seen>>,
}

pub struct FakeServer {
    /// `http://127.0.0.1:{port}`.
    pub base_url: String,
    state: Arc<State>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeServer {
    pub async fn local_models(chat: ChatBehavior) -> Result<Self, HarnessError> {
        Self::start(Kind::LocalModels, chat).await
    }

    pub async fn provider_models() -> Result<Self, HarnessError> {
        Self::start(Kind::ProviderModels, ChatBehavior::default()).await
    }

    pub async fn oauth_token() -> Result<Self, HarnessError> {
        Self::start(Kind::OauthToken, ChatBehavior::default()).await
    }

    async fn start(kind: Kind, chat: ChatBehavior) -> Result<Self, HarnessError> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let state = Arc::new(State {
            kind,
            chat,
            seen: Mutex::new(Vec::new()),
        });
        let shared = state.clone();
        let app = axum::Router::new().fallback(move |request: Request<Body>| {
            let state = shared.clone();
            async move { Ok::<_, Infallible>(handle(state, request).await) }
        });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            state,
            task,
        })
    }

    /// Every request so far, oldest first.
    pub fn seen(&self) -> Vec<Seen> {
        lock(&self.state.seen).clone()
    }

    /// The JSON bodies of the chat completions requests so far.
    pub fn chat_requests(&self) -> Vec<Value> {
        self.seen()
            .into_iter()
            .filter(|seen| seen.path.ends_with("/chat/completions"))
            .filter_map(|seen| serde_json::from_str(&seen.body).ok())
            .collect()
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn handle(state: Arc<State>, request: Request<Body>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 64 * 1024 * 1024)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let seen = Seen {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        headers: parts.headers,
        body,
    };
    let streams_before = {
        let mut all = lock(&state.seen);
        let count = all.iter().filter(|seen| is_stream_request(seen)).count();
        all.push(seen.clone());
        count
    };
    match (state.kind, &parts.method, seen.path.as_str()) {
        (Kind::LocalModels, &Method::GET, "/api/tags") => json_response(200, &ollama_tags()),
        (Kind::LocalModels, &Method::GET, "/v1/models") => json_response(200, &lm_studio_models()),
        (Kind::LocalModels, &Method::POST, "/v1/chat/completions") => {
            if streams_before > 0 && is_stream_request(&seen) {
                tokio::time::sleep(state.chat.hold_later_streams).await;
            }
            chat_completion(&state.chat, &seen.body, streams_before == 0)
        }
        (Kind::ProviderModels, &Method::GET, "/v1/models") => provider_models(&seen.headers),
        (Kind::OauthToken, &Method::POST, "/oauth/token") => json_response(200, &oauth_tokens()),
        _ => json_response(404, &json!({"error": {"message": "not found"}})),
    }
}

/// Ollama `GET /api/tags` as documented, plus an embedding model the
/// agent must leave out.
fn ollama_tags() -> Value {
    json!({"models": [
        {"name": LOCAL_MODEL, "model": LOCAL_MODEL,
         "modified_at": "2025-05-04T17:37:44.706015396-07:00", "size": 2_019_393_189_u64,
         "digest": "a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72",
         "details": {"parent_model": "", "format": "gguf", "family": "llama",
                     "families": ["llama"], "parameter_size": "3.2B", "quantization_level": "Q4_K_M"}},
        {"name": "deepseek-r1:latest", "model": "deepseek-r1:latest",
         "modified_at": "2025-05-10T08:06:48.639712648-07:00", "size": 4_683_075_271_u64,
         "digest": "0a8c266910232fd3291e71e5ba1e058cc5af9d411192cf88b6d30e92b6e73163",
         "details": {"parent_model": "", "format": "gguf", "family": "qwen2",
                     "families": ["qwen2"], "parameter_size": "7.6B", "quantization_level": "Q4_K_M"}},
        // synthetic: an embedding model entry in the documented shape.
        {"name": "nomic-embed-text:latest", "model": "nomic-embed-text:latest",
         "modified_at": "2025-05-01T10:00:00.000000000-07:00", "size": 274_302_450,
         "digest": "synthetic-digest-nomic-embed-text",
         "details": {"parent_model": "", "format": "gguf", "family": "nomic-bert",
                     "families": ["nomic-bert"], "parameter_size": "137M", "quantization_level": "F16"}}
    ]})
}

/// LM Studio `GET /v1/models` (the OpenAI list format).
fn lm_studio_models() -> Value {
    json!({"object": "list", "data": [
        {"id": "qwen3-8b", "object": "model", "owned_by": "organization_owner"},
        {"id": "text-embedding-nomic-embed-text-v1.5", "object": "model", "owned_by": "organization_owner"}
    ]})
}

fn is_stream_request(seen: &Seen) -> bool {
    seen.path.ends_with("/chat/completions")
        && serde_json::from_str::<Value>(&seen.body).is_ok_and(|body| body["stream"] == true)
}

/// `first_stream`: no streamed request came before this one.
fn chat_completion(chat: &ChatBehavior, body: &str, first_stream: bool) -> Response<Body> {
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let model = request["model"].as_str().unwrap_or(LOCAL_MODEL).to_owned();
    if request["stream"] != true {
        return json_response(
            200,
            &json!({
                "id": "chatcmpl-e2e", "object": "chat.completion", "created": 1_759_000_000,
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": chat.answer},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21}
            }),
        );
    }
    if chat.refuse_stream {
        // synthetic: a server without streaming, answering in OpenAI's error shape.
        return json_response(
            400,
            &json!({"error": {
            "message": "stream is not supported", "type": "invalid_request_error"}}),
        );
    }
    let end = if chat.cut_first_stream && first_stream {
        StreamEnd::Cut
    } else if chat.omit_done {
        StreamEnd::FinishOnly
    } else {
        StreamEnd::Done
    };
    stream_response(&model, &chat.answer, chat.chunk_delay, end)
}

/// `text/event-stream` chunks: the role, one word at a time, the finish
/// reason, then `[DONE]` (as `end` says); each after `delay`.
fn stream_response(model: &str, answer: &str, delay: Duration, end: StreamEnd) -> Response<Body> {
    let chunk = |delta: Value, finish: Value| {
        let event = json!({
            "id": "chatcmpl-e2e", "object": "chat.completion.chunk", "created": 1_759_000_000,
            "model": model, "system_fingerprint": "fp_e2e",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]
        });
        format!("data: {event}\n\n")
    };
    let mut frames = vec![chunk(
        json!({"role": "assistant", "content": ""}),
        Value::Null,
    )];
    frames.extend(
        answer
            .split_inclusive(' ')
            .map(|word| chunk(json!({"content": word}), Value::Null)),
    );
    match end {
        StreamEnd::Cut => frames.truncate(3),
        StreamEnd::FinishOnly => frames.push(chunk(json!({}), json!("stop"))),
        StreamEnd::Done => {
            frames.push(chunk(json!({}), json!("stop")));
            frames.push("data: [DONE]\n\n".to_owned());
        }
    }
    let body = stream::unfold(frames.into_iter(), move |mut frames| async move {
        let frame = frames.next()?;
        tokio::time::sleep(delay).await;
        Some((Ok::<_, Infallible>(Bytes::from(frame)), frames))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(body))
        .unwrap_or_default()
}

/// The provider's documented answers: the model list for [`GOOD_KEY`],
/// OpenAI's `insufficient_quota` for [`QUOTA_KEY`], an invalid-key error
/// otherwise. A request with `x-api-key` gets Anthropic's shapes.
fn provider_models(headers: &HeaderMap) -> Response<Body> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    if let Some(key) = header("x-api-key") {
        return anthropic_models(key);
    }
    let key = header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    match key {
        GOOD_KEY => json_response(
            200,
            &json!({"object": "list", "data": [
                {"id": "gpt-6-sol", "object": "model", "created": 1_686_935_002, "owned_by": "openai"},
                {"id": "gpt-6-luna", "object": "model", "created": 1_686_935_002, "owned_by": "openai"}
            ]}),
        ),
        QUOTA_KEY => json_response(
            429,
            &json!({"error": {
            "message": "You exceeded your current quota, please check your plan and billing details.",
            "type": "insufficient_quota", "param": null, "code": "insufficient_quota"}}),
        ),
        _ => json_response(
            401,
            &json!({"error": {
            "message": "Incorrect API key provided.", "type": "invalid_request_error",
            "param": null, "code": "invalid_api_key"}}),
        ),
    }
}

/// Anthropic's documented model list and `authentication_error`.
fn anthropic_models(key: &str) -> Response<Body> {
    if key == GOOD_KEY {
        return json_response(
            200,
            &json!({
                "data": [{"created_at": "2025-02-19T00:00:00Z", "display_name": "Claude Sonnet 3.7",
                          "id": ANTHROPIC_MODEL, "type": "model"}],
                "first_id": ANTHROPIC_MODEL, "has_more": false, "last_id": ANTHROPIC_MODEL
            }),
        );
    }
    json_response(
        401,
        &json!({"type": "error", "error": {
        "type": "authentication_error", "message": "invalid x-api-key"}}),
    )
}

/// A token response with an `id_token` and a JWT access token carrying the
/// ChatGPT claims (unsigned: the agent reads claims, it does not verify
/// the provider's signature on a token it just received over TLS).
fn oauth_tokens() -> Value {
    let claims = json!({
        "email": OAUTH_EMAIL,
        "https://api.openai.com/auth": {"chatgpt_account_id": OAUTH_ACCOUNT_ID},
        "exp": 1_999_999_999_u64
    });
    let jwt = format!(
        "{}.{}.{}",
        base64url(br#"{"alg":"none","typ":"JWT"}"#),
        base64url(claims.to_string().as_bytes()),
        base64url(b"synthetic-signature")
    );
    json!({"id_token": jwt, "access_token": jwt, "refresh_token": "e2e-refresh-token",
           "expires_in": 3600, "token_type": "Bearer"})
}

/// Base64url without padding (RFC 4648 section 5), as JWTs and PKCE use.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let at = |index: usize| u32::from(chunk.get(index).copied().unwrap_or(0));
        let value = (at(0) << 16) | (at(1) << 8) | at(2);
        for index in 0..=chunk.len() {
            let sextet = (value >> (18 - 6 * index)) & 63;
            out.push(char::from(ALPHABET[sextet as usize]));
        }
    }
    out
}

fn json_response(status: u16, value: &Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap_or_default()
}

/// The value of `name` in an `application/x-www-form-urlencoded` body
/// (values the agent sends here need no percent-decoding).
pub fn form_value<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    body.split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}
