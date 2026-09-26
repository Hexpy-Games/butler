//! Private same-executable worker protocol. The Host caller owns future admission
//! and child reaping; this process handles one CPU inference at a time.

use std::{path::PathBuf, time::Duration};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::cognition::{
    NativeEmbeddingEngine, WorkerOperation, WorkerRequest, WorkerResponse, WorkerResult,
};

mod assets;

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXTS: usize = 32;
const IDLE_EXIT: Duration = Duration::from_secs(15 * 60);

/// Called only by main's hidden private entrypoint, before normal installation.
pub async fn run() -> std::process::ExitCode {
    let data_root = std::env::var_os("BUTLER_DATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".butler")));
    let Some(data_root) = data_root else {
        return std::process::ExitCode::FAILURE;
    };
    let mut engine: Option<NativeEmbeddingEngine> = None;
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut frame = Vec::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 8 * 1024];
    let idle_exit = worker_idle_exit();
    let mut idle_deadline = tokio::time::Instant::now() + idle_exit;
    loop {
        let read = match tokio::time::timeout_at(idle_deadline, stdin.read(&mut chunk)).await {
            Ok(Ok(count)) => count,
            Ok(Err(_)) => return std::process::ExitCode::SUCCESS,
            Err(_) => {
                // Tokio's stdin reader owns a blocking read thread. Returning
                // through #[tokio::main] can wait for that thread until EOF,
                // so dispose the ORT session and terminate this private,
                // mutation-free child at idle.
                drop(engine.take());
                std::process::exit(0);
            }
        };
        if read == 0 {
            return std::process::ExitCode::SUCCESS;
        }
        for byte in &chunk[..read] {
            if *byte != b'\n' {
                if frame.len() >= MAX_FRAME_BYTES {
                    let _ = write_response(
                        &mut stdout,
                        WorkerResponse::error(0, "embed_request_too_large"),
                    )
                    .await;
                    return std::process::ExitCode::FAILURE;
                }
                frame.push(*byte);
                continue;
            }
            let request = serde_json::from_slice::<WorkerRequest>(&frame);
            frame.clear();
            let (response, close) = match request {
                Ok(request) => {
                    let close = matches!(request.op, WorkerOperation::Close);
                    (handle(request, &data_root, &mut engine).await, close)
                }
                Err(_) => (WorkerResponse::error(0, "embed_invalid_json"), false),
            };
            if write_response(&mut stdout, response).await.is_err() {
                return std::process::ExitCode::SUCCESS;
            }
            if close {
                return std::process::ExitCode::SUCCESS;
            }
            idle_deadline = tokio::time::Instant::now() + idle_exit;
        }
    }
}

async fn handle(
    request: WorkerRequest,
    data_root: &std::path::Path,
    engine: &mut Option<NativeEmbeddingEngine>,
) -> WorkerResponse {
    let id = request.id;
    let result = match request.op {
        WorkerOperation::Close => WorkerResult::Closed,
        WorkerOperation::Initialize
            if !request.texts.is_empty()
                || request.checked
                || request.resplit
                || request.max_embeddings.is_some() =>
        {
            WorkerResult::Error {
                code: "embed_invalid_request".to_owned(),
            }
        }
        WorkerOperation::Embed | WorkerOperation::Tokenize
            if request.texts.is_empty() || request.texts.len() > MAX_TEXTS =>
        {
            WorkerResult::Error {
                code: "embed_invalid_request".to_owned(),
            }
        }
        WorkerOperation::Embed if request.checked && request.texts.iter().any(String::is_empty) => {
            WorkerResult::Error {
                code: "embed_invalid_request".to_owned(),
            }
        }
        WorkerOperation::Tokenize
            if request.checked || request.resplit || request.max_embeddings.is_some() =>
        {
            WorkerResult::Error {
                code: "embed_invalid_request".to_owned(),
            }
        }
        WorkerOperation::Embed
            if (!request.checked && (request.resplit || request.max_embeddings.is_some()))
                || request
                    .max_embeddings
                    .is_some_and(|count| count == 0 || count > MAX_TEXTS) =>
        {
            WorkerResult::Error {
                code: "embed_invalid_request".to_owned(),
            }
        }
        WorkerOperation::Initialize | WorkerOperation::Embed | WorkerOperation::Tokenize => {
            if engine.is_none() {
                if let Err(code) = assets::ensure(data_root).await {
                    return WorkerResponse::error(id, code);
                }
                match NativeEmbeddingEngine::load(data_root) {
                    Ok(loaded) => *engine = Some(loaded),
                    Err(error) => {
                        return WorkerResponse::error(id, error.0);
                    }
                }
            }
            let Some(loaded) = engine.as_mut() else {
                return WorkerResponse::error(id, "embed_worker_unavailable");
            };
            match request.op {
                WorkerOperation::Initialize => Ok(WorkerResult::Ready),
                WorkerOperation::Tokenize => loaded
                    .tokenize(&request.texts)
                    .map(WorkerResult::Tokenization),
                WorkerOperation::Embed => loaded
                    .embed(
                        &request.texts,
                        request.checked,
                        request.resplit,
                        request.max_embeddings,
                    )
                    .map(|result| WorkerResult::Embedding(Box::new(result))),
                // Handled by the outer match.
                WorkerOperation::Close => Ok(WorkerResult::Closed),
            }
            .unwrap_or_else(|error| WorkerResult::Error {
                code: error.0.to_owned(),
            })
        }
    };
    WorkerResponse { id, result }
}

fn worker_idle_exit() -> Duration {
    std::env::var("EMBED_IDLE_RECYCLE_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(|ms| Duration::from_millis(ms.min(24 * 60 * 60 * 1000)))
        .unwrap_or(IDLE_EXIT)
}

async fn write_response(
    stdout: &mut tokio::io::Stdout,
    response: WorkerResponse,
) -> Result<(), ()> {
    let mut bytes = serde_json::to_vec(&response).map_err(|_| ())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        bytes = serde_json::to_vec(&WorkerResponse::error(
            response.id,
            "embed_response_too_large",
        ))
        .map_err(|_| ())?;
    }
    bytes.push(b'\n');
    stdout.write_all(&bytes).await.map_err(|_| ())?;
    stdout.flush().await.map_err(|_| ())
}
