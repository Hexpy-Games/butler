//! Isolated embedding model evaluator using Butler's ort and tokenizers versions.

use std::{
    error::Error,
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Instant,
};

use ort::{
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use serde::{Deserialize, Serialize};
use tokenizers::{Encoding, Tokenizer};

type EvalResult<T> = Result<T, Box<dyn Error>>;

#[derive(Deserialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each independent ORT switch is crossed in the benchmark matrix"
)]
struct Config {
    #[serde(default)]
    product_defaults: bool,
    model: PathBuf,
    tokenizer: PathBuf,
    dataset: PathBuf,
    max_tokens: usize,
    pool: String,
    query_prefix: String,
    document_prefix: String,
    chunking: String,
    optimization: String,
    prepacking: bool,
    cpu_arena: bool,
    memory_pattern: bool,
    threads: usize,
    env_allocators: bool,
}

#[derive(Deserialize)]
struct Dataset {
    documents: Vec<Document>,
    queries: Vec<Query>,
}
#[derive(Deserialize)]
struct Document {
    id: String,
    text: String,
}
#[derive(Deserialize)]
struct Query {
    id: String,
    text: String,
    category: String,
    mode: String,
    gold_source_ids: Vec<String>,
    gold_answer: String,
}

#[derive(Serialize)]
struct Score {
    id: String,
    category: String,
    mode: String,
    rank: Option<usize>,
    evidence_found: bool,
}

#[derive(Serialize)]
struct Summary {
    load_ms: f64,
    ingest_ms: f64,
    query_ms: Vec<f64>,
    recall1: usize,
    recall5: usize,
    mrr: f64,
    scores: Vec<Score>,
    document_vectors: usize,
}

fn session(config: &Config) -> EvalResult<Session> {
    if config.product_defaults {
        let builder = Session::builder()?;
        let builder = builder.with_intra_threads(1).map_err(|e| e.to_string())?;
        let mut builder = builder.with_inter_threads(1).map_err(|e| e.to_string())?;
        return Ok(builder.commit_from_file(&config.model)?);
    }
    let level = match config.optimization.as_str() {
        "disable" => GraphOptimizationLevel::Disable,
        "basic" => GraphOptimizationLevel::Level1,
        "extended" => GraphOptimizationLevel::Level2,
        "all" => GraphOptimizationLevel::All,
        _ => return Err("invalid optimization level".into()),
    };
    let builder = Session::builder()?;
    let builder = builder
        .with_intra_threads(config.threads)
        .map_err(|e| e.to_string())?;
    let builder = builder.with_inter_threads(1).map_err(|e| e.to_string())?;
    let builder = builder
        .with_optimization_level(level)
        .map_err(|e| e.to_string())?;
    let builder = builder
        .with_memory_pattern(config.memory_pattern)
        .map_err(|e| e.to_string())?;
    let builder = builder
        .with_config_entry(
            "session.disable_prepacking",
            if config.prepacking { "0" } else { "1" },
        )
        .map_err(|e| e.to_string())?;
    let builder = builder
        .with_config_entry(
            "session.use_env_allocators",
            if config.env_allocators { "1" } else { "0" },
        )
        .map_err(|e| e.to_string())?;
    let builder = builder
        .with_config_entry("session.intra_op.allow_spinning", "0")
        .map_err(|e| e.to_string())?;
    let mut builder = builder;
    if !config.cpu_arena {
        builder = builder
            .with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()])
            .map_err(|e| e.to_string())?;
    }
    Ok(builder.commit_from_file(&config.model)?)
}

fn chunks(
    tokenizer: &Tokenizer,
    text: &str,
    max_tokens: usize,
    strategy: &str,
) -> EvalResult<Vec<Encoding>> {
    let full = tokenizer.encode(text, true).map_err(|e| e.to_string())?;
    if full.len() <= max_tokens {
        return Ok(vec![full]);
    }
    if max_tokens < 128 {
        return Err("max_tokens too small".into());
    }
    let result = if strategy == "sentence" {
        sentence_chunks(tokenizer, text, max_tokens)?
    } else if strategy == "overlap64" {
        token_chunks(tokenizer, full.get_ids(), max_tokens)?
    } else {
        return Err("unknown chunk strategy".into());
    };
    if result.iter().any(|part| part.len() > max_tokens) {
        return Err("chunk exceeds limit".into());
    }
    Ok(result)
}

fn token_chunks(
    tokenizer: &Tokenizer,
    ids: &[u32],
    max_tokens: usize,
) -> EvalResult<Vec<Encoding>> {
    let payload = &ids[1..ids.len() - 1];
    let width = max_tokens - 64;
    let step = width - 64;
    let mut result = Vec::new();
    for start in (0..payload.len()).step_by(step) {
        let end = (start + width).min(payload.len());
        let decoded = tokenizer
            .decode(&payload[start..end], true)
            .map_err(|e| e.to_string())?;
        result.push(tokenizer.encode(decoded, true).map_err(|e| e.to_string())?);
        if end == payload.len() {
            break;
        }
    }
    Ok(result)
}

fn sentence_chunks(
    tokenizer: &Tokenizer,
    text: &str,
    max_tokens: usize,
) -> EvalResult<Vec<Encoding>> {
    let mut result = Vec::new();
    let mut current = String::new();
    for sentence in text.split_inclusive(['.', '!', '?', '。', '\n']) {
        let candidate = format!("{current}{sentence}");
        if tokenizer
            .encode(candidate.as_str(), true)
            .map_err(|e| e.to_string())?
            .len()
            > max_tokens - 16
        {
            if !current.is_empty() {
                result.push(
                    tokenizer
                        .encode(current.as_str(), true)
                        .map_err(|e| e.to_string())?,
                );
                current.clear();
            }
            if tokenizer
                .encode(sentence, true)
                .map_err(|e| e.to_string())?
                .len()
                > max_tokens - 16
            {
                let encoded = tokenizer
                    .encode(sentence, true)
                    .map_err(|e| e.to_string())?;
                result.extend(token_chunks(tokenizer, encoded.get_ids(), max_tokens)?);
                continue;
            }
        }
        current.push_str(sentence);
    }
    if !current.is_empty() {
        result.push(
            tokenizer
                .encode(current.as_str(), true)
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(result)
}

fn infer(session: &mut Session, encoded: &Encoding, pool: &str) -> EvalResult<Vec<f32>> {
    let mut inputs = Vec::new();
    for input in session.inputs() {
        let values: Vec<i64> = match input.name() {
            "input_ids" => encoded.get_ids(),
            "attention_mask" => encoded.get_attention_mask(),
            "token_type_ids" => encoded.get_type_ids(),
            name => return Err(format!("unsupported model input: {name}").into()),
        }
        .iter()
        .map(|v| i64::from(*v))
        .collect();
        inputs.push((
            input.name().to_owned(),
            Tensor::from_array(([1, encoded.len()], values))?,
        ));
    }
    let outputs = session.run(inputs)?;
    let output = outputs
        .get("sentence_embedding")
        .or_else(|| outputs.get("last_hidden_state"))
        .or_else(|| outputs.get("logits"))
        .or_else(|| outputs.get("token_embeddings"))
        .ok_or("no supported output")?;
    let (shape, data) = output.try_extract_tensor::<f32>()?;
    let dims = &**shape;
    let dimension = match dims {
        [1, dim] | [1, _, dim] => usize::try_from(*dim)?,
        _ => return Err(format!("unsupported output shape: {dims:?}").into()),
    };
    let mut vector = vec![0f32; dimension];
    if dims.len() == 2 || pool == "cls" {
        vector.copy_from_slice(&data[..dimension]);
    } else {
        let mask = encoded.get_attention_mask();
        let count: f32 = mask.iter().sum::<u32>() as f32;
        for (active, row) in mask.iter().zip(data.chunks_exact(dimension)) {
            if *active != 0 {
                for (dst, value) in vector.iter_mut().zip(row) {
                    *dst += *value / count;
                }
            }
        }
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the finite norm of f32 components fits f32"
    )]
    let norm = vector
        .iter()
        .map(|v| f64::from(*v).powi(2))
        .sum::<f64>()
        .sqrt() as f32;
    if !norm.is_finite() || norm <= 0.0 {
        return Err("invalid embedding norm".into());
    }
    for value in &mut vector {
        *value /= norm;
    }
    Ok(vector)
}

fn embed(
    session: &mut Session,
    tokenizer: &Tokenizer,
    text: &str,
    config: &Config,
) -> EvalResult<Vec<Vec<f32>>> {
    chunks(tokenizer, text, config.max_tokens, &config.chunking)?
        .iter()
        .map(|part| infer(session, part, &config.pool))
        .collect()
}

fn rank(
    query: &[Vec<f32>],
    docs: &[(String, Vec<Vec<f32>>)],
    relevant: &[String],
) -> (Option<usize>, Option<String>) {
    let mut scored: Vec<_> = docs
        .iter()
        .map(|(id, vectors)| {
            let score = query
                .iter()
                .flat_map(|q| {
                    vectors
                        .iter()
                        .map(move |d| q.iter().zip(d).map(|(a, b)| a * b).sum::<f32>())
                })
                .fold(f32::NEG_INFINITY, f32::max);
            (id, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let found = scored
        .iter()
        .position(|(id, _)| relevant.contains(id))
        .map(|i| i + 1);
    (found, scored.first().map(|(id, _)| (*id).clone()))
}

fn evaluate(
    config: &Config,
    session: &mut Session,
    tokenizer: &Tokenizer,
    dataset: Dataset,
    load_ms: f64,
) -> EvalResult<Summary> {
    let mut docs = Vec::new();
    let ingest_start = Instant::now();
    for document in &dataset.documents {
        let vectors = embed(
            session,
            tokenizer,
            &format!("{}{}", config.document_prefix, document.text),
            config,
        )?;
        docs.push((document.id.clone(), vectors));
    }
    let ingest_ms = ingest_start.elapsed().as_secs_f64() * 1000.0;
    let mut query_ms = Vec::new();
    let mut scores = Vec::new();
    for query in dataset.queries {
        let start = Instant::now();
        let vector = embed(
            session,
            tokenizer,
            &format!("{}{}", config.query_prefix, query.text),
            config,
        )?;
        let (rank, top) = rank(&vector, &docs, &query.gold_source_ids);
        query_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        scores.push(Score {
            id: query.id,
            category: query.category,
            mode: query.mode,
            rank,
            evidence_found: top
                .and_then(|id| dataset.documents.iter().find(|doc| doc.id == id))
                .is_some_and(|doc| doc.text.contains(&query.gold_answer)),
        });
    }
    let recall1 = scores.iter().filter(|s| s.rank == Some(1)).count();
    let recall5 = scores
        .iter()
        .filter(|s| s.rank.is_some_and(|rank| rank <= 5))
        .count();
    let mrr = scores
        .iter()
        .filter_map(|s| s.rank.map(|rank| 1.0 / rank as f64))
        .sum::<f64>()
        / scores.len() as f64;
    Ok(Summary {
        load_ms,
        ingest_ms,
        query_ms,
        recall1,
        recall5,
        mrr,
        scores,
        document_vectors: docs.iter().map(|(_, v)| v.len()).sum(),
    })
}

fn main() -> EvalResult<()> {
    let config_path = std::env::args().nth(1).ok_or("config path required")?;
    let config: Config = serde_json::from_slice(&fs::read(config_path)?)?;
    let dataset: Dataset = serde_json::from_slice(&fs::read(&config.dataset)?)?;
    let tokenizer = Tokenizer::from_file(&config.tokenizer).map_err(|e| e.to_string())?;
    let start = Instant::now();
    let mut session = session(&config)?;
    let load_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!("LOADED");
    io::stdout().flush()?;
    io::stdin().lock().read_line(&mut String::new())?;
    let summary = evaluate(&config, &mut session, &tokenizer, dataset, load_ms)?;
    println!("{}", serde_json::to_string(&summary)?);
    io::stdout().flush()?;
    io::stdin().lock().read_line(&mut String::new())?;
    Ok(())
}
