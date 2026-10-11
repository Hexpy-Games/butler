//! Offline functional companion: real web tools, a planner stub and streaming HTTP fixtures.
use butler_models::models::{
    ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ProviderPromptResult,
};
use butler_runtime::web_access::testing;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt::Write as _,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Planner(Mutex<Vec<Value>>);

impl ProviderPromptPort for Planner {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        let plan = json!({"depth":"deep","intent":"compare sources","scope":"comparison",
            "decomposition":[{"id":"source","label":"Sources","priority":"high"}],
            "queries":(["alpha","beta","gamma"].map(|query|json!({"bucketId":"source","query":query,"purpose":"comparison","priority":"high","expectedSourceType":"review"}))),
            "verificationRequired":true}).to_string();
        self.0.lock().push(json!({
            "model":request.model.unwrap_or("inherited-model"),"effort":request.reasoning_effort,
            "prompt_bytes":request.prompt.len()+request.instructions.map_or(0,str::len),"output_bytes":plan.len(),
        }));
        Box::pin(async move {
            let started = Instant::now();
            tokio::time::sleep(Duration::from_millis(40)).await;
            if let Some(profile) = self.0.lock().last_mut() {
                profile["ttft_ms"] = json!(started.elapsed().as_millis());
                profile["duration_ms"] = json!(started.elapsed().as_millis());
            }
            if let Some(observer) = request.stream_observer {
                observer.event(&json!({"type":"response.output_text.delta","delta":plan}));
            }
            Ok(ProviderPromptResult {
                text: plan,
                model: "offline-planner".into(),
                usage: None,
            })
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::var("BUTLER_DATA")?);
    tokio::fs::create_dir_all(&root).await?;
    let socket = TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", socket.local_addr()?);
    let events = Arc::new(Mutex::new(HashMap::new()));
    let server_events = events.clone();
    let clock = Instant::now();
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = socket.accept().await {
            let events = server_events.clone();
            tokio::spawn(async move {
                let _ = serve(stream, events, clock).await;
            });
        }
    });
    let planner = Arc::new(Planner::default());
    let session = testing::access_with_planner(root, &format!("{base}/search"), planner.clone())
        .session_for_turn("Compare three subjects with primary and independent sources".into());
    let started = Instant::now();
    let search = session
        .web_search(
            &json!({"query":"source query","max_results":10}),
            &CancellationToken::new(),
        )
        .await?;
    let search_ms = started.elapsed().as_millis();
    let followup = session
        .web_search(
            &json!({"query":"missing source","max_results":5}),
            &CancellationToken::new(),
        )
        .await?;
    let started = Instant::now();
    let page = session
        .web_read(
            &json!({"url":format!("{base}/page"),"max_chars":10000,"max_chunks":20}),
            &CancellationToken::new(),
        )
        .await?;
    let read_ms = started.elapsed().as_millis();
    server.abort();
    let report = json!({"search_ms":search_ms,"read_ms":read_ms,"planner":planner.0.lock().clone(),
        "request_events":events.lock().clone(),"search":search,"followup":followup,"page":page});
    std::fs::write(
        std::env::var("BUTLER_WEB_PROBE_RESULT")?,
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}

type RequestEvents = Arc<Mutex<HashMap<String, (u128, u128)>>>;

async fn serve(
    mut stream: TcpStream,
    events: RequestEvents,
    clock: Instant,
) -> std::io::Result<()> {
    let mut request = vec![0; 4096];
    let n = stream.read(&mut request).await?;
    let request = String::from_utf8_lossy(&request[..n]);
    let target = request.split_whitespace().nth(1).unwrap_or("/");
    let url = url::Url::parse(&format!("http://fixture{target}")).map_err(std::io::Error::other)?;
    let page = url.path() == "/page";
    let q = url
        .query_pairs()
        .find(|(key, _)| key == "q")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let began = clock.elapsed().as_millis();
    let body = if page {
        page_html()
    } else {
        tokio::time::sleep(Duration::from_millis(if q == "alpha" { 300 } else { 80 })).await;
        let mut html = String::new();
        for i in 0..5 {
            let _ = write!(
                html,
                "<div class=result><a class=result__a href=\"https://example.com/{q}/{i}\">Title {q}/{i}</a><div class=result__snippet>{}</div></div>",
                snippet(&q, i)
            );
        }
        html
    };
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await?;
    for chunk in body.as_bytes().chunks(64 * 1024) {
        stream
            .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
            .await?;
        stream.write_all(chunk).await?;
        stream.write_all(b"\r\n").await?;
        if page {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    if !page {
        events
            .lock()
            .insert(q, (began, clock.elapsed().as_millis()));
    }
    stream.write_all(b"0\r\n\r\n").await
}

fn snippet(q: &str, i: usize) -> String {
    format!(
        "Full details {q}/{i}: {}",
        "Complete source content. ".repeat(60)
    )
}

fn page_html() -> String {
    let mut main = String::new();
    for i in 0..12 {
        let _ = write!(main, "<p>Source paragraph {i}: all details retained.</p>");
    }
    format!(
        "<html><head><title>Streaming document</title></head><body><main>{main}</main>{}<script>let huge='{}';setInterval(()=>fetch('/poll'),1000)</script></body></html>",
        "<script src='/background.js' async></script>".repeat(8),
        "x".repeat(2 * 1024 * 1024)
    )
}
