//! HTTP hooks: the command envelope POSTed to a local endpoint in the harness.
use super::*;
#[path = "http_receiver.rs"]
mod receiver;
#[path = "http_signing.rs"]
mod signing;
use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use std::sync::{Arc, Mutex};

/// One request the endpoint received.
#[derive(Clone)]
struct Seen {
    method: String,
    path: String,
    headers: HeaderMap,
    body: Value,
    raw: Vec<u8>,
}

/// Local hook receiver; each path selects one response shape.
struct Endpoint {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Endpoint {
    async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let app = axum::Router::new().fallback(
            move |method: axum::http::Method, uri: Uri, headers: HeaderMap, body: Bytes| {
                let log = log.clone();
                async move {
                    log.lock().unwrap().push(Seen {
                        method: method.as_str().into(),
                        path: uri.path().into(),
                        headers,
                        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                        raw: body.to_vec(),
                    });
                    respond(uri.path()).await
                }
            },
        );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { base, seen, task })
    }
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    fn seen(&self, path: &str) -> Vec<Seen> {
        let seen = self.seen.lock().unwrap();
        seen.iter().filter(|s| s.path == path).cloned().collect()
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn respond(path: &str) -> Response {
    match path {
        "/slow" => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        "/fail" => (StatusCode::INTERNAL_SERVER_ERROR, "boom").into_response(),
        "/moved" => (StatusCode::FOUND, [(header::LOCATION, "/deny")]).into_response(),
        "/deny" => axum::Json(json!({"decision":"deny","reason":"No send"})).into_response(),
        "/guard" => axum::Json(json!({"hookSpecificOutput":{
            "permissionDecision":"deny","permissionDecisionReason":"Guard reason"}}))
        .into_response(),
        _ => StatusCode::OK.into_response(),
    }
}

fn http_hook(id: &str, event: &str, url: &str) -> Value {
    json!({"id":id,"event":event,"type":"http","url":url,"timeout_ms":3000})
}

/// A loopback port nothing listens on.
fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

async fn last_run(s: &Scenario) -> Result<Value, HarnessError> {
    let runs = api(s, Method::GET, "/hooks/runs", None).await?;
    Ok(runs.data().as_array().unwrap().last().unwrap().clone())
}

fn without_identity(mut payload: Value) -> Value {
    payload.as_object_mut().unwrap().remove("hook");
    payload
}

const EVENTS: [&str; 5] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
];

#[tokio::test]
async fn hooks_http_posts_the_command_envelope_for_each_event() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let setup = setup("HOOK-HTTP-EVENTS")?.synthetic(Script {
        rounds: 1,
        path_for: Box::new(|_| "hook-input.txt".into()),
        final_text: "Done.".into(),
    });
    fs::write(
        setup.sandbox.data.join("hook-input.txt"),
        "Exact tool content",
    )?;
    // The command observer requests one Stop continuation; the HTTP hook observes.
    let mut hooks: Vec<Value> = EVENTS.iter().map(|e| observer(&setup, e)).collect();
    hooks.extend(
        EVENTS
            .iter()
            .map(|e| http_hook(&format!("http-{e}"), e, &endpoint.url("/observe"))),
    );
    let s = setup.start().await?;
    replace(&s, hooks).await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Hooks"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"].as_str().unwrap();
    let (_, turn) = s.turn(chat, "Read hook-input.txt, then finish.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let delivered = endpoint.seen("/observe");
    let secrets = [
        s.agent.launch.token.clone(),
        s.agent.launch.admin_credential().unwrap(),
    ];
    for request in &delivered {
        assert_eq!(request.method, "POST");
        assert_eq!(request.headers[header::CONTENT_TYPE], "application/json");
        for name in [header::AUTHORIZATION, header::COOKIE] {
            assert!(!request.headers.contains_key(&name), "{name}");
        }
        let raw = request.body.to_string();
        assert!(secrets.iter().all(|secret| !raw.contains(secret.as_str())));
        let event = request.body["hook_event_name"].as_str().unwrap();
        assert_eq!(
            request.body["hook"],
            json!({"id":format!("http-{event}"),"scope":"user"})
        );
    }
    let commands = payloads(&s.sandbox.home);
    for event in EVENTS {
        let pick = |all: Vec<Value>| -> Vec<Value> {
            all.into_iter()
                .filter(|p| p["hook_event_name"] == event)
                .map(without_identity)
                .collect()
        };
        let http = pick(delivered.iter().map(|r| r.body.clone()).collect());
        let command = pick(commands.clone());
        assert_eq!(http.len(), if event == "Stop" { 2 } else { 1 }, "{event}");
        assert_eq!(http, command, "{event}");
    }
    let stops: Vec<_> = delivered
        .iter()
        .filter(|r| r.body["hook_event_name"] == "Stop")
        .collect();
    assert_eq!(stops[1].body["stop_hook_active"], true);
    assert_eq!(stops[1].body["last_assistant_message"], "Done.");
    s.finish().await
}

#[tokio::test]
async fn hooks_http_deny_response_blocks_tool_and_prompt() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let setup = Setup::new("HOOK-HTTP-DENY")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .access(Access::AskAlways);
    let mut guard = http_hook("guard", "PreToolUse", &endpoint.url("/guard"));
    guard["match"] = json!({"tools":["run_command"]});
    let s = setup.start().await?;
    replace(&s, vec![guard]).await?;
    s.provider()?.set_chat_responder(stub::command);
    let (turn_id, turn) = s.turn("general", "Run the hook test command.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(!s.sandbox.home.join("tool-ran").exists());
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let denied = rows
        .iter()
        .find(|r| r["tool_call_id"] == "call_hooks")
        .unwrap();
    assert_eq!(denied["state"], "failed", "{rows:?}");
    let requests = s.provider()?.requests();
    assert!(
        requests.iter().skip(1).any(
            |r| r.to_string().contains("hook_denied") && r.to_string().contains("Guard reason")
        ),
        "{requests:?}"
    );
    assert_eq!(last_run(&s).await?["http_status"], 200);
    replace(
        &s,
        vec![http_hook(
            "deny",
            "UserPromptSubmit",
            &endpoint.url("/deny"),
        )],
    )
    .await?;
    let blocked =
        s.gw.post("/messages", json!({"chat_id":"general","text":"No send."}))
            .await?;
    assert_eq!(blocked.status, 422, "{blocked:?}");
    assert_eq!(blocked.error_code(), Some("hook_blocked"));
    assert!(blocked.text.contains("No send"), "{blocked:?}");
    s.finish().await
}

#[tokio::test]
async fn hooks_http_failures_continue_unless_failclosed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-FAILURES")?.start().await?;
    let unreachable = format!("http://127.0.0.1:{}/hook", closed_port());
    let cases = [
        (endpoint.url("/slow"), "timeout", Value::Null),
        (endpoint.url("/fail"), "error", json!(500)),
        (endpoint.url("/moved"), "error", json!(302)),
        (unreachable, "error", Value::Null),
    ];
    for (url, outcome, status) in cases {
        let mut hook = http_hook("remote", "UserPromptSubmit", &url);
        hook["timeout_ms"] = json!(300);
        replace(&s, vec![hook.clone()]).await?;
        let (_, turn) = s.turn("general", "Failure proceeds.").await?;
        assert_eq!(turn["state"], "delivered", "{url}: {turn}");
        let run = last_run(&s).await?;
        assert_eq!(run["outcome"], outcome, "{url}: {run}");
        assert_eq!(run["http_status"], status, "{url}: {run}");
        assert!(run["duration_ms"].as_u64().unwrap() < 10_000, "{run}");
        assert!(!run["stderr"].as_str().unwrap().contains(&url), "{run}");
        hook["failClosed"] = json!(true);
        replace(&s, vec![hook]).await?;
        let blocked =
            s.gw.post("/messages", json!({"chat_id":"general","text":"Blocked."}))
                .await?;
        assert_eq!(blocked.status, 422, "{url}: {blocked:?}");
        assert_eq!(blocked.error_code(), Some("hook_blocked"));
    }
    // The redirect was refused, never followed to the deny endpoint.
    assert!(endpoint.seen("/deny").is_empty());
    s.finish().await
}

#[tokio::test]
async fn hooks_http_accepts_only_http_urls_and_tests_endpoint() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let endpoint = Endpoint::start().await?;
    let s = setup("HOOK-HTTP-CONFIG")?.start().await?;
    let url = endpoint.url("/observe");
    let mut invalid = vec![
        http_hook("bad", "Stop", "file:///etc/hosts"),
        http_hook("bad", "Stop", "ftp://127.0.0.1/hook"),
        http_hook("bad", "Stop", "http://user:secret@127.0.0.1/hook"),
        http_hook("bad", "Stop", "https://"),
        json!({"id":"bad","event":"Stop","type":"http","timeout_ms":3000}),
    ];
    let mut with_command = http_hook("bad", "Stop", &url);
    with_command["command"] = json!("echo");
    let mut with_env = http_hook("bad", "Stop", &url);
    with_env["env"] = json!({"A":"B"});
    let mut command_with_url = hook("bad", "Stop", "echo");
    command_with_url["url"] = json!(url);
    invalid.extend([with_command, with_env, command_with_url]);
    for hook in invalid {
        let current = api(&s, Method::GET, "/hooks", None).await?;
        let saved = api(
            &s,
            Method::PUT,
            "/hooks",
            Some(json!({"revision":current.data()["revision"],"config":{"version":1,"hooks":[hook]}})),
        )
        .await?;
        assert_eq!(saved.status, 400, "{hook}: {saved:?}");
        assert_eq!(saved.error_code(), Some("hook_invalid"));
    }
    replace(&s, vec![http_hook("probe", "Stop", &url)]).await?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert_eq!(settings.data()["config"]["hooks"][0]["url"], url);
    let tested = api(&s, Method::POST, "/hooks/probe/test", Some(json!({}))).await?;
    assert_eq!(tested.status, 200, "{tested:?}");
    assert_eq!(tested.data()["outcome"], "continue");
    assert_eq!(tested.data()["http_status"], 200);
    let seen = endpoint.seen("/observe");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].body["hook_event_name"], "Stop");
    assert!(seen[0].body["session_id"].is_null());
    s.finish().await
}
