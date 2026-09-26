use std::{
    collections::VecDeque,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::models::{
    ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ProviderPromptResult,
};

use super::super::WebAccess;

struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

fn data_root() -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("native-search-providers-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

async fn listener() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    (listener, base)
}

fn serve(listener: TcpListener, replies: Vec<Reply>) -> JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut requests = Vec::new();
        for reply in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            requests.push(read_headers(&mut stream).await);
            let reason = if reply.status == 500 {
                "Internal Server Error"
            } else {
                "OK"
            };
            let headers = format!(
                "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.status,
                reply.content_type,
                reply.body.len(),
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(reply.body.as_bytes()).await.unwrap();
        }
        requests
    })
}

async fn read_headers(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut chunk = [0; 2_048];
    loop {
        let read = stream.read(&mut chunk).await.unwrap();
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&request).into_owned()
}

fn write_config(root: &std::path::Path, config: &Value) {
    fs::write(
        root.join("butler.config.json"),
        serde_json::to_vec(config).unwrap(),
    )
    .unwrap();
}

fn search_reply(url: &str) -> String {
    json!({"results":[{
        "title":"Fixture result",
        "url":url,
        "content":"A public fixture result."
    }]})
    .to_string()
}

#[tokio::test]
async fn tavily_uses_exact_data_key_and_rereads_private_environment() {
    let root = data_root();
    let (socket, base) = listener().await;
    write_config(
        &root,
        &json!({"webSearch":{"provider":"tavily","tavilyApiBase":format!("{base}/search")}}),
    );
    fs::write(root.join(".env"), "BUTLER_TAVILY_API_KEY=first-data-key\n").unwrap();
    let response = search_reply("https://example.com/tavily");
    let server = serve(
        socket,
        vec![
            Reply {
                status: 200,
                content_type: "application/json",
                body: response.clone(),
            },
            Reply {
                status: 200,
                content_type: "application/json",
                body: response,
            },
        ],
    );
    let access = WebAccess::for_test(root.clone(), &format!("{base}/search"));
    let session = access.session_for_turn(String::new());
    let first = session
        .web_search(&json!({"query":"first query"}), &CancellationToken::new())
        .await
        .unwrap();
    fs::write(root.join(".env"), "BUTLER_TAVILY_API_KEY=second-data-key\n").unwrap();
    let second = session
        .web_search(&json!({"query":"second query"}), &CancellationToken::new())
        .await
        .unwrap();
    let requests = server.await.unwrap();

    assert_eq!(first["provider"], "tavily");
    assert_eq!(second["provider"], "tavily");
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer first-data-key")
    );
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer second-data-key")
    );
    drop(session);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn brave_provider_failure_falls_back_to_duckduckgo() {
    let root = data_root();
    let (socket, base) = listener().await;
    write_config(
        &root,
        &json!({"webSearch":{"provider":"brave","braveApiBase":format!("{base}/brave")}}),
    );
    fs::write(
        root.join(".env"),
        "BUTLER_BRAVE_SEARCH_API_KEY=fixture-brave-key\n",
    )
    .unwrap();
    let html = r#"<div class="result"><a class="result__a" href="https://example.com/fallback">Fallback source</a><div class="result__snippet">Fallback snippet</div></div>"#;
    let server = serve(
        socket,
        vec![
            Reply {
                status: 500,
                content_type: "application/json",
                body: "{}".into(),
            },
            Reply {
                status: 200,
                content_type: "text/html",
                body: html.into(),
            },
        ],
    );
    let access = WebAccess::for_test(root.clone(), &format!("{base}/search"));
    let result = access
        .session_for_turn(String::new())
        .web_search(&json!({"query":"fallback test"}), &CancellationToken::new())
        .await
        .unwrap();
    let requests = server.await.unwrap();

    assert_eq!(result["provider"], "duckduckgo-html");
    assert_eq!(result["results"][0]["url"], "https://example.com/fallback");
    assert!(requests[0].starts_with("GET /brave?"));
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("x-subscription-token: fixture-brave-key")
    );
    assert!(requests[1].starts_with("GET /search?"));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn auto_uses_data_openai_key_without_process_environment() {
    let root = data_root();
    let (socket, base) = listener().await;
    write_config(
        &root,
        &json!({"webSearch":{"provider":"auto","apiBase":base,
            "planning":{"mode":"off"}}}),
    );
    fs::write(root.join(".env"), "OPENAI_API_KEY=fixture-openai-key\n").unwrap();
    let body = json!({"output":[{"action":{"sources":[{
        "url":"https://example.com/openai",
        "title":"OpenAI fixture source"
    }]}}]})
    .to_string();
    let server = serve(
        socket,
        vec![Reply {
            status: 200,
            content_type: "application/json",
            body,
        }],
    );
    let models = crate::host::NativeProcessModels::new(
        root.clone(),
        crate::models::ModelConfigurationEnvironment::default(),
        Arc::new(crate::configuration::ConfigurationWrites::new()),
        Arc::new(crate::locale::LocaleCollation::new("en-US").unwrap()),
    )
    .unwrap();
    let access = WebAccess::new(
        root.clone(),
        models.configuration.clone(),
        models.provider.clone(),
        Arc::new(crate::operations::WebSearchMetrics::new(root.clone())),
    )
    .unwrap();
    let result = access
        .session_for_turn(String::new())
        .web_search(
            &json!({"query":"private OpenAI auth"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let requests = server.await.unwrap();

    assert_eq!(result["provider"], "openai-web-search");
    assert_eq!(result["results"][0]["url"], "https://example.com/openai");
    assert!(requests[0].starts_with("POST /v1/responses "));
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-openai-key")
    );
    let _ = fs::remove_dir_all(root);
}

struct PlannerFixture {
    replies: Mutex<VecDeque<String>>,
    prompts: Mutex<Vec<String>>,
}

impl PlannerFixture {
    fn new(replies: impl IntoIterator<Item = String>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().collect()),
            prompts: Mutex::new(Vec::new()),
        }
    }
}

impl ProviderPromptPort for PlannerFixture {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        self.prompts.lock().unwrap().push(request.prompt.to_owned());
        let reply = self.replies.lock().unwrap().pop_front().unwrap_or_default();
        Box::pin(async move {
            Ok(ProviderPromptResult {
                text: reply,
                model: "planner-fixture".into(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn planner_uses_turn_context_executes_plan_then_uses_direct_follow_up() {
    let root = data_root();
    write_config(&root, &json!({"webSearch":{"provider":"mock"}}));
    let plan = json!({
        "depth":"deep",
        "intent":"compare alpha and beta",
        "scope":"comparison",
        "decomposition":[
            {"id":"alpha","label":"Alpha facts","reason":"Official source","priority":"high"},
            {"id":"beta","label":"Beta reviews","reason":"Independent review","priority":"normal"}
        ],
        "queries":[
            {"bucketId":"alpha","query":"Alpha official announcement","purpose":"official","priority":"high","expectedSourceType":"official"},
            {"bucketId":"beta","query":"Beta independent review","purpose":"comparison","priority":"normal","expectedSourceType":"review"}
        ],
        "verificationRequired":true,
        "notes":[]
    })
    .to_string();
    let prompt = Arc::new(PlannerFixture::new([plan]));
    let access =
        WebAccess::for_test_with_prompt(root.clone(), "http://127.0.0.1:9/search", prompt.clone());
    let session = access.session_for_turn("Compare Alpha and Beta with evidence sources.".into());
    let planned = session
        .web_search(&json!({"query":"alpha beta"}), &CancellationToken::new())
        .await
        .unwrap();
    let direct = session
        .web_search(
            &json!({"query":"follow-up source"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let prompts = prompt.prompts.lock().unwrap();

    assert_eq!(planned["search_plan"]["mode"], "smart");
    assert_eq!(planned["search_plan"]["planner_attempts"], 1);
    assert_eq!(planned["usage"]["search_requests"], 2);
    assert_eq!(
        planned["results"][0]["url"],
        "https://example.com/butler-web-search"
    );
    assert!(prompts[0].contains("Compare Alpha and Beta with evidence sources."));
    assert_eq!(prompts.len(), 1);
    assert_eq!(direct["search_plan"]["mode"], "direct");
    assert_eq!(direct["search_plan"]["planner_used"], false);
    assert!(
        direct["search_plan"]["fallback_reason"]
            .as_str()
            .unwrap()
            .contains("already ran")
    );
    drop(prompts);
    drop(session);
    let _ = fs::remove_dir_all(root);
}
