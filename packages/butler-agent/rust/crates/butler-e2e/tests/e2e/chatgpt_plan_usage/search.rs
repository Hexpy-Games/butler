//! Hosted plan search and local DuckDuckGo fallback through the search companion.
use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
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
    mode: String,
    primary: usize,
    fallback: usize,
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
    async fn start(mode: &str) -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let base = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(Mutex::new(SearchState {
            mode: mode.into(),
            primary: 0,
            fallback: 0,
        }));
        let app = Router::new().route("/v1/responses",post(primary))
            .route_layer(axum::middleware::from_fn(butler_e2e::e2e::chatgpt_wire::validate))
            .route("/v1/models",get(|| async { Json(json!({"models":[{"slug":"gpt-6-luna","display_name":"Luna","visibility":"list"}]})) }))
            .route("/search",get(ddg)).with_state(state.clone());
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
    match state.mode.as_str() {
        "unsupported" => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":{"code":"subscription_sharing_unsupported_capability"}})),
            )
                .into_response();
        }
        "route" => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":{"code":"subscription_sharing_route_not_supported"}})),
            )
                .into_response();
        }
        "500" => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":{"code":"temporary"}})),
            )
                .into_response();
        }
        "401" if state.primary == 1 => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"detail":"identity rejected"})),
            )
                .into_response();
        }
        _ => {}
    }
    let events = [
        json!({"type":"response.metadata","metadata":{}}),
        json!({"type":"response.web_search_call.searching"}),
        json!({"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.org/source","title":"Hosted source"}}),
        json!({"type":"response.completed","response":{"output":[{"type":"web_search_call","action":{"sources":[{"type":"url","url":"https://example.org/source","title":"Hosted source"}]}},{"type":"message","content":[{"type":"output_text","text":"A sourced overview.","annotations":[{"type":"url_citation","url":"https://example.org/source","title":"Hosted source"}]}]}]}}),
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
async fn ddg(State(state): State<Arc<Mutex<SearchState>>>) -> &'static str {
    state.lock().unwrap().fallback += 1;
    "<div class=\"result\"><a class=\"result__a\" href=\"https://example.org/fallback\">Fallback source</a><a class=\"result__snippet\">Local fallback result</a></div>"
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
async fn siwc_16_hosted_search_alias_memo_fallback_and_refresh() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (provider, mode) in [
        ("chatgpt-plan-web-search", "success"),
        ("codex-subscription-web-search", "success"),
        ("chatgpt-plan-web-search", "unsupported"),
        ("chatgpt-plan-web-search", "route"),
        ("chatgpt-plan-web-search", "500"),
        ("chatgpt-plan-web-search", "401"),
    ] {
        let server = Server::start(mode).await?;
        let s = super::super::chatgpt_session::scenario(&format!("SIWC-16-{mode}")).await?;
        let path = s.sandbox.data.join("butler.config.json");
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        config["webSearch"] =
            json!({"provider":provider,"model":"openai/gpt-6-luna","planning":{"enabled":false}});
        std::fs::write(&path, serde_json::to_vec(&config)?)?;
        if provider == "codex-subscription-web-search" {
            let settings =
                s.gw.patch("/settings", json!({"web_search":{"provider":provider}}))
                    .await?;
            assert_eq!(settings.status, 200, "{}", settings.text);
            let saved: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
            assert_eq!(saved["webSearch"]["provider"], "chatgpt-plan-web-search");
            // A previously saved alias remains readable as well.
            std::fs::write(&path, serde_json::to_vec(&config)?)?;
        }
        let mut companion = Companion::start(&s, &server)?;
        let result = companion.search().await?;
        let fallback = matches!(mode, "unsupported" | "route" | "500");
        assert_eq!(
            result["provider"],
            if fallback {
                "duckduckgo-html"
            } else {
                "chatgpt-plan-web-search"
            },
            "{result}"
        );
        assert!(
            result["results"].as_array().is_some_and(|r| !r.is_empty()),
            "{result}"
        );
        assert_eq!(
            result["results"][0]["url"],
            if fallback {
                "https://example.org/fallback"
            } else {
                "https://example.org/source"
            }
        );
        if matches!(mode, "unsupported" | "route") {
            let again = companion.search().await?;
            assert_eq!(again["provider"], "duckduckgo-html", "{again}");
            assert_eq!(server.state.lock().unwrap().primary, 1);
            assert_eq!(server.state.lock().unwrap().fallback, 2);
        } else {
            assert_eq!(
                server.state.lock().unwrap().primary,
                if mode == "401" { 2 } else { 1 }
            );
            assert_eq!(server.state.lock().unwrap().fallback, usize::from(fallback));
        }
        if mode == "401" {
            assert_eq!(
                s.authority
                    .as_ref()
                    .unwrap()
                    .seen()
                    .iter()
                    .filter(|r| r.path == "token")
                    .count(),
                1
            );
        }
        companion.child.kill().await?;
        companion.child.wait().await?;
        s.finish().await?;
    }
    Ok(())
}
