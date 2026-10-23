//! Hosted plan search returns sources through the search companion.
use super::*;
use axum::{
    Json, Router,
    extract::State,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::Value;
use std::fmt::Write as _;
use std::{
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
struct SearchState {
    primary: usize,
}
struct Server {
    base: String,
    state: Arc<Mutex<SearchState>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(Mutex::new(SearchState { primary: 0 }));
        let app = Router::new().route("/v1/responses",post(primary))
            .route_layer(axum::middleware::from_fn(butler_e2e::e2e::chatgpt_wire::validate))
            .route("/v1/models",get(|| async { Json(json!({"models":[{"slug":"gpt-6-luna","display_name":"Luna","visibility":"list"}]})) }))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { base, state, task })
    }
}
async fn primary(
    State(state): State<Arc<Mutex<SearchState>>>,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(body["tools"][0]["type"], "web_search");
    assert_eq!(body["include"], json!(["web_search_call.action.sources"]));
    let mut state = state.lock().unwrap();
    state.primary += 1;
    let events = [
        json!({"type":"response.metadata","metadata":{}}),
        json!({"type":"response.web_search_call.searching"}),
        json!({"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.org/citation","title":"Cited source"}}),
        json!({"type":"response.completed","response":{"output":[{"type":"web_search_call","action":{"sources":[{"type":"url","url":"https://example.org/source","title":"Hosted source"}]}},{"type":"message","content":[{"type":"output_text","text":"A sourced overview.","annotations":[{"type":"url_citation","url":"https://example.org/citation","title":"Cited source"}]}]}]}}),
    ];
    (
        [("content-type", "text/event-stream")],
        events.iter().fold(String::new(), |mut out, event| {
            let _ = write!(out, "data: {event}\n\n");
            out
        }),
    )
        .into_response()
}
struct Companion {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
}
impl Drop for Companion {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
impl Companion {
    fn start(
        s: &butler_e2e::e2e::scenario::Scenario,
        server: &Server,
    ) -> Result<Self, HarnessError> {
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_siwc_search"))
            .arg(&s.sandbox.data)
            .arg(format!("{}/v1", server.base))
            .arg(format!("{}/search", server.base))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(std::fs::File::create(
                s.sandbox.logs.join("siwc-search.stderr"),
            )?))
            .kill_on_drop(true)
            .spawn()?;
        let input = child.stdin.take().unwrap();
        let output = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        Ok(Self {
            child,
            input,
            output,
        })
    }
    async fn search(&mut self) -> Result<Value, HarnessError> {
        self.input.write_all(b"hosted search contract\n").await?;
        self.input.flush().await?;
        let line =
            tokio::time::timeout(std::time::Duration::from_secs(30), self.output.next_line())
                .await
                .map_err(|e| HarnessError(e.to_string()))??
                .ok_or_else(|| HarnessError("search companion exited".into()))?;
        Ok(serde_json::from_str(&line)?)
    }
}
#[tokio::test]
async fn siwc_16_chatgpt_plan_web_search_returns_sources() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = Server::start().await?;
    let authority = FakeChatGptAuthority::start().await?;
    let setup = butler_e2e::e2e::scenario::Setup::new("SIWC-16")?
        .without_credential()
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer);
    butler_e2e::e2e::fixtures::stub_chatgpt_auth(&setup.sandbox.data, &authority)?;
    let s = setup.start().await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"chatgpt-plan-web-search",
        "model":"openai/gpt-6-luna","planning":{"enabled":false}});
    std::fs::write(&path, serde_json::to_vec(&config)?)?;
    let mut companion = Companion::start(&s, &server)?;
    let result = companion.search().await?;
    assert_eq!(result["provider"], "chatgpt-plan-web-search", "{result}");
    assert!(
        result["results"].as_array().is_some_and(|r| !r.is_empty()),
        "{result}"
    );
    assert_eq!(result["results"][0]["url"], "https://example.org/source");
    assert_eq!(result["results"][0]["title"], "Hosted source");
    assert_eq!(result["results"].as_array().unwrap().len(), 2);
    assert_eq!(result["results"][1]["url"], "https://example.org/citation");
    assert_eq!(result["results"][1]["title"], "Cited source");
    assert_eq!(server.state.lock().unwrap().primary, 1);
    companion.child.kill().await?;
    companion.child.wait().await?;
    config["webSearch"]["provider"] = "codex-subscription-web-search".into();
    std::fs::write(&path, serde_json::to_vec(&config)?)?;
    let mut upgraded = Companion::start(&s, &server)?;
    let result = upgraded.search().await?;
    assert_eq!(result["provider"], "chatgpt-plan-web-search");
    assert_eq!(result["results"][0]["url"], "https://example.org/source");
    assert_eq!(server.state.lock().unwrap().primary, 2);
    upgraded.child.kill().await?;
    upgraded.child.wait().await?;
    s.finish().await
}
