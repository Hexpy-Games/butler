//! Offline product-path measurement. No service or projection consumers start.
use butler_memory::cognition::{CognitionPathEnvironment, GenerationVectorAdapter, MemoryRecall};
use butler_turn::conversation::CanonicalMemoryReadBinding;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};
mod vector_trace;

// Compile unchanged native host modules; no private production API exports.
include!(concat!(env!("OUT_DIR"), "/native.rs"));

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args
        .get(1)
        .is_some_and(|arg| arg == "--private-embedding-worker")
    {
        std::process::exit(i32::from(
            worker::run().await != std::process::ExitCode::SUCCESS,
        ));
    }
    if args.len() != 4 {
        return Err("usage: butler-real-recall-bench DATA QUERIES OUTPUT".into());
    }
    private_output(&args[3])?;
    let root = PathBuf::from(&args[1]);
    let embedding = Arc::new(owner::EmbeddingOwner::new(root.clone())?);
    let trace = Arc::new(vector_trace::Trace {
        embedding: embedding.clone(),
        last: Arc::new(parking_lot::Mutex::new(json!({"state":"not_attempted"}))),
    });
    let vectors = Arc::new(GenerationVectorAdapter::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        trace.clone(),
    ));
    let vector = recall(root.clone())?.with_vector_port(vectors);
    let novector = recall(root)?;
    warm(&embedding, &args[3]).await?;
    run_queries(&args[2], &args[3], &vector, &novector, &trace).await?;
    vector.close().await;
    novector.close().await;
    embedding.close().await?;
    Ok(())
}

async fn run_queries(
    queries: &str,
    output_path: &str,
    vector: &MemoryRecall,
    novector: &MemoryRecall,
    trace: &vector_trace::Trace,
) -> Result<(), Box<dyn std::error::Error>> {
    let input = std::io::BufReader::new(std::fs::File::open(queries)?);
    let mut output = std::io::BufWriter::new(std::fs::File::create(output_path)?);
    for (index, line) in input.lines().enumerate() {
        let query: Value = serde_json::from_str(&line?)?;
        // Rotate arm order to balance warm-up and host load.
        let arms = ["A1", "B1", "A2", "B2"];
        let variants = query["arms"].as_array().cloned().unwrap_or_else(|| {
            arms.iter()
                .map(|arm| {
                    json!({
                        "name": arm, "vector": arm.starts_with('A'),
                        "arguments": if arm.ends_with('1') {
                            json!({"cue":query["query"]})
                        } else { query["model_args"].clone() },
                    })
                })
                .collect()
        });
        for offset in 0..variants.len() {
            let variant = &variants[(index + offset) % variants.len()];
            let arm = variant["name"].as_str().ok_or("arm name missing")?;
            let use_vector = variant["vector"].as_bool().ok_or("vector flag missing")?;
            let reader = if use_vector { vector } else { novector };
            let arguments = variant["arguments"].clone();
            *trace.last.lock() = json!({"state":"not_attempted"});
            let start = Instant::now();
            let result = reader
                .recall_tool(
                    binding(&query)?,
                    variant
                        .get("current_user_message")
                        .unwrap_or(&query["query"])
                        .as_str()
                        .ok_or("user message missing")?
                        .into(),
                    format!("bench-{index}-{arm}"),
                    arguments,
                )
                .await;
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            let record = record(&query, arm, use_vector, elapsed, result, trace)?;
            serde_json::to_writer(&mut output, &record)?;
            writeln!(output)?;
            output.flush()?;
        }
        eprintln!("completed query {}", index + 1);
    }
    Ok(())
}

fn record(
    query: &Value,
    arm: &str,
    use_vector: bool,
    elapsed: f64,
    result: Result<Value, butler_memory::cognition::CognitionError>,
    trace: &vector_trace::Trace,
) -> Result<Value, Box<dyn std::error::Error>> {
    let (payload, error) = match result {
        Ok(payload) => (payload, Value::Null),
        Err(error) => (Value::Null, json!(error.to_string())),
    };
    let text = if payload.is_null() {
        String::new()
    } else {
        serde_json::to_string(&payload)?
    };
    let ids: Vec<Value> = payload["results"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| row["episode_ref"].clone())
        .collect();
    let gold_ranks: serde_json::Map<String, Value> = query["gold_episode_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|gold| {
            gold.as_str().map(|id| {
                (
                    id.to_owned(),
                    json!(
                        ids.iter()
                            .position(|found| found == gold)
                            .map(|rank| rank + 1)
                    ),
                )
            })
        })
        .collect();
    let mut lane = trace.last.lock().clone();
    if !use_vector {
        lane = json!({"state":"unavailable", "reason":"adapter_omitted"});
    } else if payload["coverage"]["vectors"]["state"] == "unavailable" && lane["state"] == "ran" {
        lane["search_status"] = json!("unavailable_or_timed_out");
    }
    Ok(
        json!({"id":query["id"], "query_id":query["query_id"], "arm":arm,
        "wall_ms":elapsed, "vector_lane":lane, "bytes":text.len(),
        "ranked_episode_ids":ids, "gold_ranks":gold_ranks,
        "payload_text":text.chars().take(6000).collect::<String>(),
        "payload_text_truncated":text.chars().count() > 6000,
        "payload":payload, "error":error}),
    )
}

fn binding(query: &Value) -> Result<CanonicalMemoryReadBinding, Box<dyn std::error::Error>> {
    Ok(CanonicalMemoryReadBinding {
        runtime_session_id: query["binding"]["session_id"]
            .as_str()
            .ok_or("binding session missing")?
            .into(),
        turn_id: query["binding"]["turn_id"]
            .as_str()
            .ok_or("binding turn missing")?
            .into(),
        project_id: query["binding"]["project_id"].as_str().map(str::to_owned),
    })
}

fn recall(root: PathBuf) -> Result<MemoryRecall, Box<dyn std::error::Error>> {
    let compare = butler_core::locale::LocaleCollation::new("en-US")?;
    Ok(MemoryRecall::new(
        root,
        CognitionPathEnvironment::default(),
        Arc::new(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|date| date.timestamp_millis())
        }),
        Arc::new(move |left, right| compare.compare(left, right)),
        Arc::new(|| chrono::Utc::now().timestamp_millis()),
        1,
    ))
}

async fn warm(
    embedding: &owner::EmbeddingOwner,
    output: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use butler_memory::cognition::{
        CognitionEmbeddingPort, EmbeddingMode, EmbeddingRequest, EmbeddingRequestClass,
    };
    let start = Instant::now();
    let result = embedding
        .embed(
            EmbeddingRequest {
                texts: vec!["메모리 검색".into()],
                mode: EmbeddingMode::CheckedCls,
                resplit: true,
                max_embeddings: Some(1),
                request_class: EmbeddingRequestClass::Interactive,
                deadline_at_epoch_ms: None,
            },
            tokio_util::sync::CancellationToken::new(),
        )
        .await;
    std::fs::write(
        format!("{output}.warmup.json"),
        serde_json::to_vec_pretty(&json!({
            "wall_ms":start.elapsed().as_secs_f64()*1000.0,
            "error":result.as_ref().err().map(std::string::ToString::to_string),
        }))?,
    )?;
    result?;
    Ok(())
}

fn private_output(output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let parent = std::path::Path::new(output)
        .parent()
        .ok_or("output parent missing")?
        .canonicalize()?;
    if parent.starts_with(repository) {
        return Err("private benchmark output must be outside the worktree".into());
    }
    Ok(())
}
