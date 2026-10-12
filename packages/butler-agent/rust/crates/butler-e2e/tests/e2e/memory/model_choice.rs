//! Memory without the memory model: multilingual chat recall with no vectors, no
//! download and no worker; switching on later downloads and backfills, off releases.
use super::fts::{count, recall, settled, start_with};
use axum::{Router, body::Body, extract::Path as UrlPath, response::Response, routing::get};
use butler_e2e::e2e::{HarnessError, fixtures, scenario::Scenario};
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;

const COMPLETE: &str = "SELECT COUNT(*) FROM memory_vector_units WHERE state='complete'";
const PENDING: &str = "SELECT COUNT(*) FROM memory_vector_units WHERE state='pending'";

fn model_root(data: &Path) -> PathBuf {
    data.join("cache/models/Xenova/bge-m3")
}

async fn choose(s: &Scenario, enabled: bool) -> Result<Value, HarnessError> {
    let reply =
        s.gw.post("/setup/memory-model", json!({ "enabled": enabled }))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["memory_model"].clone())
}

fn embedding_workers(s: &Scenario) -> Result<Option<usize>, HarnessError> {
    Ok(
        butler_platform::process_control::usage::embedding_children(s.agent.pid().unwrap())?
            .map(|workers| workers.len()),
    )
}

/// Off before the first turn; the fact is recalled in its own language from text lanes.
async fn remembered_off(
    word: &str,
    cue: &str,
    model_source: (&str, &str),
) -> Result<(Scenario, PathBuf), HarnessError> {
    let (s, remember) = start_with(word, cue, Value::Null, model_source).await?;
    assert_eq!(choose(&s, false).await?["state"], "off");
    s.select_model(&s.model).await?;
    let access =
        s.gw.patch("/settings", json!({"access_mode":"full_access"}));
    assert_eq!(access.await?.status, 200);
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", word))
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let graph = settled(&s, 1).await?;
    let db =
        butler_platform::sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let session: String = db.query_row("SELECT conversation_session_id FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%' LIMIT 1", [], |r| r.get(0)).unwrap();
    drop(db);
    s.provider()?.add_placeholder("SOURCE_SESSION", session);
    let found = recall(&s).await?;
    assert_eq!(found["ok"], true, "{found}");
    assert!(
        found["output"]["results"].to_string().contains(word),
        "{found}"
    );
    let vectors = &found["output"]["coverage"]["vectors"];
    assert_eq!(vectors["codes"], json!(["embedding_disabled"]), "{found}");
    assert_eq!(count(&graph, COMPLETE), 0);
    assert!(
        count(&graph, PENDING) > 0,
        "units wait as the backfill queue"
    );
    assert!(!model_root(&s.sandbox.data).exists(), "off never downloads");
    if let Some(workers) = embedding_workers(&s)? {
        assert_eq!(workers, 0, "off recall loaded an embedding worker");
    }
    Ok((s, graph))
}

async fn off_scenario(word: &str, cue: &str) -> Result<(), HarnessError> {
    let unavailable = (
        "BUTLER_E2E_EMBED_MANIFEST",
        "http://127.0.0.1:1/unavailable",
    );
    let (s, _) = remembered_off(word, cue, unavailable).await?;
    let stages = recall_stage_ms(&s.sandbox.data)?;
    eprintln!(
        "MEM-OFF {cue}: recall=pass vectors=0 workers=0 download=none recall_stages_ms={stages:.3}"
    );
    s.finish().await
}

/// Graph read plus source hydration of the one recall (the vector lane never ran).
fn recall_stage_ms(data: &Path) -> Result<f64, HarnessError> {
    let events = std::fs::read_to_string(data.join("metrics/operational-events.jsonl"))?;
    Ok(events
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| {
            event["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("recall_v2_"))
        })
        .filter_map(|event| event["durationMs"].as_f64())
        .sum())
}

#[tokio::test]
async fn mem_off_korean() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    off_scenario("청자비밀번호", "청자").await
}

#[tokio::test]
async fn mem_off_english() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    off_scenario("Azure Café STRAßE", "CAFÉ strasse").await
}

#[tokio::test]
async fn mem_off_japanese() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    off_scenario("自転車の暗証番号", "暗証").await
}

#[tokio::test]
async fn mem_off_then_on_backfills_then_off_releases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let assets = tempdir_assets()?;
    let source = serve(assets.clone()).await;
    let (s, graph) = remembered_off(
        "청자비밀번호",
        "청자",
        ("BUTLER_E2E_EMBED_SOURCES", &source),
    )
    .await?;
    let pending = count(&graph, PENDING);
    choose(&s, true).await?;
    let started = Instant::now();
    wait(Duration::from_secs(300), || async {
        Ok(s.gw.get("/setup/readiness").await?.data()["memory_model"]["state"] == "ready")
    })
    .await?;
    let open = "SELECT COUNT(*) FROM memory_vector_units WHERE state IN ('pending','running')";
    wait(Duration::from_secs(300), || async {
        Ok(count(&graph, open) == 0 && count(&graph, COMPLETE) > 0)
    })
    .await?;
    eprintln!(
        "MEM-ON backfill units={pending} after_ms={}",
        started.elapsed().as_millis()
    );
    let found = recall(&s).await?;
    assert!(
        found["output"]["results"]
            .to_string()
            .contains("청자비밀번호"),
        "{found}"
    );
    let complete = count(&graph, COMPLETE);
    assert_eq!(choose(&s, false).await?["state"], "off");
    assert!(
        !model_root(&s.sandbox.data)
            .join("onnx/model_quantized.onnx")
            .exists(),
        "off frees the model"
    );
    assert_eq!(count(&graph, COMPLETE), complete, "off keeps vectors");
    if let Some(workers) = embedding_workers(&s)? {
        assert_eq!(workers, 0, "off reaps the worker");
    }
    let again = recall(&s).await?;
    let vectors = &again["output"]["coverage"]["vectors"];
    assert_eq!(vectors["codes"], json!(["embedding_disabled"]), "{again}");
    s.finish().await
}

/// The real pinned model files, as CI supplies them; required for a true backfill.
fn tempdir_assets() -> Result<PathBuf, HarnessError> {
    let dir = std::env::var("BUTLER_E2E_EMBEDDING_ASSETS")
        .map(PathBuf::from)
        .unwrap_or_default();
    assert!(
        fixtures::EMBEDDING_ASSETS
            .iter()
            .all(|asset| dir.join(asset).is_file()),
        "local embedding assets required"
    );
    Ok(dir)
}

/// A local mirror of the pinned assets; the product verifies every SHA-256.
async fn serve(dir: PathBuf) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/{*file}",
        get(move |UrlPath(file): UrlPath<String>| asset(dir.join(file))),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    address
}

async fn asset(path: PathBuf) -> Response {
    let Ok(file) = tokio::fs::File::open(&path).await else {
        return Response::builder().status(404).body(Body::empty()).unwrap();
    };
    let length = file.metadata().await.unwrap().len();
    let stream = futures_util::stream::unfold(file, |mut file| async move {
        let mut chunk = vec![0; 1 << 20];
        match file.read(&mut chunk).await {
            Ok(0) | Err(_) => None,
            Ok(read) => {
                chunk.truncate(read);
                Some((Ok::<_, std::io::Error>(bytes::Bytes::from(chunk)), file))
            }
        }
    });
    Response::builder()
        .header("content-length", length)
        .body(Body::from_stream(stream))
        .unwrap()
}

async fn wait<F, Fut>(limit: Duration, mut done: F) -> Result<(), HarnessError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool, HarnessError>>,
{
    let deadline = Instant::now() + limit;
    while !done().await? {
        assert!(
            Instant::now() < deadline,
            "condition not reached in {limit:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}
