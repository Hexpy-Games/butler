//! Memory without the memory model: multilingual chat recall with no vectors, no
//! download and no worker; switching on later downloads and backfills, off releases.
use super::fts::{ASK, count, recall_asking, settled, start_corpus};
use axum::{Router, body::Body, extract::Path as UrlPath, response::Response, routing::get};
use butler_e2e::e2e::{HarnessError, fixtures, scenario::Scenario};
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;

const COMPLETE: &str = "SELECT COUNT(*) FROM memory_vector_units WHERE state='complete'";
const PENDING: &str = "SELECT COUNT(*) FROM memory_vector_units WHERE state='pending'";

/// Facts said in turns of their own beside the remembered word. The raw source
/// lane matches grapheme bigrams and trigrams of the cue; none of these cues
/// shares two of them with any stored text, so only episode FTS can find them:
/// it folds diacritics (`ete` finds `été`) and indexes one-syllable words.
const FACTS: [&str; 3] = [
    "Our été trip went to Nîmes.",
    "내 차가 빨간색이야.",
    "The bakery near the station sells rye bread.",
];
const TRIP: (&str, &str) = ("Recall my summer trip.", "ete");
const CAR: (&str, &str) = ("Recall my car colour.", "차 색");
/// A cue in a script no stored text uses: an empty, complete recall.
const NOTHING: (&str, &str) = ("Recall my bread order.", "ψωμί");

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

/// With the memory model off the vector lane is switched off, not failing: the
/// recall is complete, never partial for want of vectors.
fn assert_model_off(found: &Value) {
    assert_eq!(found["ok"], true, "{found}");
    let vectors = &found["output"]["coverage"]["vectors"];
    assert_eq!(vectors["state"], "disabled", "{found}");
    assert_eq!(vectors["codes"], json!(["embedding_disabled"]), "{found}");
    assert_eq!(found["output"]["status"], "complete", "{found}");
}

/// Recalls with `ask` and requires a result holding `needle`.
async fn finds(s: &Scenario, ask: &str, needle: &str) -> Result<Value, HarnessError> {
    let found = recall_asking(s, ask).await?;
    assert_eq!(found["ok"], true, "{found}");
    assert!(
        found["output"]["results"].to_string().contains(needle),
        "{ask} must find {needle}: {found}"
    );
    Ok(found)
}

/// Off before the first turn; the word and `facts` are said in their own turns
/// and the word is recalled in its own language from text lanes.
async fn remembered_off(
    word: &str,
    cue: &str,
    model_source: (&str, &str),
    facts: &[&str],
    asks: &[(&str, &str)],
) -> Result<(Scenario, PathBuf), HarnessError> {
    let all = [(ASK, cue)]
        .into_iter()
        .chain(asks.iter().copied())
        .collect::<Vec<_>>();
    let (s, remember) = start_corpus(word, facts, &all, Value::Null, model_source).await?;
    assert_eq!(choose(&s, false).await?["state"], "off");
    s.select_model(&s.model).await?;
    let access =
        s.gw.patch("/settings", json!({"access_mode":"full_access"}));
    assert_eq!(access.await?.status, 200);
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", word))
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    for fact in facts {
        let (_, turn) = s.turn("general", fact).await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
    }
    let graph = settled(&s, 1 + facts.len() as u64).await?;
    let db =
        butler_platform::sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let session: String = db.query_row("SELECT conversation_session_id FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%' LIMIT 1", [], |r| r.get(0)).unwrap();
    drop(db);
    s.provider()?.add_placeholder("SOURCE_SESSION", session);
    let found = finds(&s, ASK, word).await?;
    assert_model_off(&found);
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
    let (s, _) = remembered_off(word, cue, unavailable, &[], &[]).await?;
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

/// The episode holding `needle` was a candidate of the recall for `cue` through
/// episode FTS alone: a lexical rank with no raw-source or mention score.
fn fts_only(data: &Path, graph: &Path, cue: &str, needle: &str) -> Result<(), HarnessError> {
    let db =
        butler_platform::sqlite::open_with_flags(graph, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let episode: String = db.query_row("SELECT s.episode_id FROM memory_chunk_sources s JOIN memory_source_text t ON t.source_id=s.source_id WHERE t.text LIKE '%'||?1||'%' LIMIT 1", [needle], |r| r.get(0)).unwrap();
    drop(db);
    let hash = |value: &str| format!("{:x}", sha2::Sha256::digest(value.as_bytes()));
    let events = std::fs::read_to_string(data.join("metrics/operational-events.jsonl"))?;
    let candidate = events
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| event["name"] == "recall_v2_ranking")
        .map(|event| event["dimensions"].clone())
        .rfind(|found| {
            found["ranking_stage"] == "candidate"
                && found["cue_sha256"] == hash(cue)
                && found["episode_sha256"] == hash(&episode)
        })
        .unwrap_or_else(|| panic!("{needle} was no candidate for {cue}"));
    assert!(candidate["l_rank"].as_f64().unwrap() > 0.0, "{candidate}");
    assert_eq!(candidate["l_score"], 0.0, "raw lane matched: {candidate}");
    assert_eq!(candidate["g_score"], 0.0, "{candidate}");
    Ok(())
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

/// Off, a corpus of several facts: episode FTS recalls a diacritic-folded word
/// and one-syllable Korean words the raw lane cannot match, and a cue nothing
/// matches is a clean, complete "no hits".
#[tokio::test]
async fn mem_off_text_lanes_recall_what_raw_grams_miss() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let unavailable = (
        "BUTLER_E2E_EMBED_MANIFEST",
        "http://127.0.0.1:1/unavailable",
    );
    let asks = [TRIP, CAR, NOTHING];
    let (s, graph) = remembered_off("청자비밀번호", "청자", unavailable, &FACTS, &asks).await?;
    assert_model_off(&finds(&s, TRIP.0, "Nîmes").await?);
    fts_only(&s.sandbox.data, &graph, TRIP.1, "Nîmes")?;
    let car = finds(&s, CAR.0, "빨간색").await?;
    assert_model_off(&car);
    fts_only(&s.sandbox.data, &graph, CAR.1, "빨간색")?;
    assert!(
        !car["output"]["results"].to_string().contains("Nîmes"),
        "one-syllable words match together, not alone: {car}"
    );
    let nothing = recall_asking(&s, NOTHING.0).await?;
    assert_model_off(&nothing);
    assert_eq!(nothing["output"]["results"], json!([]), "{nothing}");
    assert_eq!(
        nothing["output"]["coverage"]["graph"]["codes"],
        json!(["no_hits"]),
        "{nothing}"
    );
    eprintln!("MEM-OFF corpus: diacritic=pass one_syllable=pass no_hits=complete");
    s.finish().await
}

#[tokio::test]
async fn mem_off_then_on_backfills_then_off_releases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let assets = tempdir_assets()?;
    let source = serve(assets.clone()).await;
    let (mut s, graph) = remembered_off(
        "청자비밀번호",
        "청자",
        ("BUTLER_E2E_EMBED_SOURCES", &source),
        &FACTS,
        &[TRIP],
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
    finds(&s, ASK, "청자비밀번호").await?;
    partly_embedded(&mut s, &graph).await?;
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
    assert_model_off(&finds(&s, ASK, "청자비밀번호").await?);
    s.finish().await
}

/// A corpus mid-backfill: the trip fact's units wait (not yet due) while the rest
/// are embedded. Once vectors are searched, episode FTS still runs beside them
/// and finds the unembedded fact the raw lane cannot match.
async fn partly_embedded(s: &mut Scenario, graph: &Path) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let db = butler_platform::sqlite::open(graph).unwrap();
    let waiting = db.execute("UPDATE memory_vector_units SET state='pending',receipt_json=NULL,next_attempt_at='2999-01-01T00:00:00.000Z' WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j JOIN memory_chunk_sources s ON s.episode_id=j.episode_id AND s.revision=j.revision JOIN memory_source_text t ON t.source_id=s.source_id WHERE t.text LIKE '%Nîmes%')", []).unwrap();
    drop(db);
    assert!(waiting > 0 && count(graph, COMPLETE) > 0, "a mixed corpus");
    let loads = s.agent.logs().matches("[embedding-worker] ready").count();
    s.gw = s.agent.start_again().await?;
    // The first recall loads the model; its vector lane may miss the deadline.
    finds(s, TRIP.0, "Nîmes").await?;
    wait(Duration::from_secs(300), || async {
        Ok(s.agent.logs().matches("[embedding-worker] ready").count() > loads)
    })
    .await?;
    let mixed = finds(s, TRIP.0, "Nîmes").await?;
    fts_only(&s.sandbox.data, graph, TRIP.1, "Nîmes")?;
    let vectors = &mixed["output"]["coverage"]["vectors"];
    assert!(
        vectors["state"] == "ok" || vectors["state"] == "partial",
        "vectors were searched beside FTS: {mixed}"
    );
    assert!(vectors["candidates"].as_u64().unwrap() > 0, "{mixed}");
    assert_eq!(
        count(graph, PENDING),
        i64::try_from(waiting).unwrap(),
        "the wait holds"
    );
    eprintln!("MEM-ON mixed corpus: fts+vectors=pass waiting_units={waiting}");
    Ok(())
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
