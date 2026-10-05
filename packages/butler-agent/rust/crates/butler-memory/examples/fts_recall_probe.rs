//! Offline projection/recall acceptance. Inputs and outputs belong on disposable data.
use butler_memory::{
    cognition::{
        CognitionPathEnvironment, MemoryGenerationTarget, MemoryRecall, RecallMetric,
        RecallMetricSink, advance_rebuild_cache, resolve_active_generation,
    },
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
        CoordinationResult,
    },
};
use butler_turn::conversation::CanonicalMemoryReadBinding;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

struct Host;
impl CognitionCoordinationHost for Host {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("offline-fts-probe".into())
    }
    fn process_status(&self, _: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Uncertain
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn now_iso(&self) -> String {
        chrono::Utc::now().to_rfc3339()
    }
}
#[derive(Default)]
struct Metrics(parking_lot::Mutex<Vec<Value>>);
impl RecallMetricSink for Metrics {
    fn record(&self, metric: RecallMetric) {
        if let RecallMetric::CandidateRanking {
            episode_sha256,
            candidate_rank,
            candidate_score,
            g_rank,
            v_rank,
            l_rank,
            l_score,
            c_rank,
            ..
        } = metric
        {
            self.0.lock().push(json!({"episode_sha256":episode_sha256,"rank":candidate_rank,"score":candidate_score,"g_rank":g_rank,"v_rank":v_rank,"l_rank":l_rank,"l_score":l_score,"c_rank":c_rank}));
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    let root = PathBuf::from(args.get(1).ok_or("disposable DATA path required")?);
    if args.get(2).is_some_and(|arg| arg == "--backfill") {
        return backfill(root).await;
    }
    if args.len() != 4 {
        return Err("usage: fts_recall_probe DATA QUERIES OUTPUT | DATA --backfill".into());
    }
    let output = PathBuf::from(&args[3]);
    let worktree = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(5)
        .ok_or("worktree root unavailable")?
        .canonicalize()?;
    if output
        .parent()
        .ok_or("output needs parent")?
        .canonicalize()?
        .starts_with(worktree)
    {
        return Err("private output must be outside the worktree".into());
    }
    let metrics = Arc::new(Metrics::default());
    let recall = reader(root, metrics.clone())?;
    let queries = std::io::BufReader::new(std::fs::File::open(&args[2])?);
    let mut out = std::io::BufWriter::new(std::fs::File::create(output)?);
    for line in queries.lines() {
        let query: Value = serde_json::from_str(&line?)?;
        let binding = CanonicalMemoryReadBinding {
            runtime_session_id: query["binding"]["session_id"]
                .as_str()
                .ok_or("missing session")?
                .into(),
            turn_id: query["binding"]["turn_id"]
                .as_str()
                .ok_or("missing turn")?
                .into(),
            project_id: query["binding"]["project_id"].as_str().map(str::to_owned),
        };
        metrics.0.lock().clear();
        let start = Instant::now();
        let result = recall
            .recall_tool(
                binding,
                query["query"].as_str().ok_or("missing question")?.into(),
                query["id"].as_str().ok_or("missing id")?.into(),
                json!({"cue":query["query"]}),
            )
            .await;
        let wall_ms = start.elapsed().as_secs_f64() * 1000.0;
        let (payload, error) = match result {
            Ok(payload) => (payload, Value::Null),
            Err(error) => (Value::Null, json!(error.to_string())),
        };
        let record = json!({"id":query["id"],"wall_ms":wall_ms,"payload":payload,"error":error,"candidate_metrics":metrics.0.lock().clone()});
        serde_json::to_writer(&mut out, &record)?;
        writeln!(out)?;
        out.flush()?;
    }
    recall.close().await;
    Ok(())
}

async fn backfill(root: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let environment = CognitionPathEnvironment::default();
    let handle = resolve_active_generation(&root, &environment)?;
    let target = MemoryGenerationTarget::Active {
        expected_generation: handle.generation_id,
    };
    let owner = Arc::new(CognitionWriteCoordinator::new(Arc::new(Host))?);
    let started = Instant::now();
    let mut quanta = 0;
    while advance_rebuild_cache(
        &root,
        &environment,
        owner.clone(),
        &target,
        &CancellationToken::new(),
    )
    .await?
    {
        quanta += 1;
    }
    println!(
        "{}",
        json!({"quanta":quanta,"wall_ms":started.elapsed().as_secs_f64()*1000.0})
    );
    Ok(())
}

fn reader(
    root: PathBuf,
    metrics: Arc<Metrics>,
) -> Result<MemoryRecall, Box<dyn std::error::Error>> {
    let compare = butler_core::locale::LocaleCollation::new("en-US")?;
    Ok(MemoryRecall::new(
        root,
        CognitionPathEnvironment::default(),
        Arc::new(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|d| d.timestamp_millis())
        }),
        Arc::new(move |a, b| compare.compare(a, b)),
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
        1,
    )
    .with_metric_sink(metrics))
}
