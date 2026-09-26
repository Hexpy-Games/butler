//! Bounded private-worker process and stdio framing.

use std::process::Stdio;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::cognition::{
    CognitionError, CognitionResult, EmbeddingMode, NativeEmbeddingResult, WorkerOperation,
    WorkerRequest, WorkerResponse, WorkerResult,
};

use super::{error, queue::Pending};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct WorkerChild {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: ChildStdout,
    pub(super) initialized: bool,
}

pub(super) fn spawn_worker(
    executable: &std::path::Path,
    data_root: &std::path::Path,
) -> CognitionResult<WorkerChild> {
    let mut child = Command::new(executable)
        .arg("--private-embedding-worker")
        .env("BUTLER_DATA", data_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| error("embed_worker_unavailable"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| error("embed_worker_unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| error("embed_worker_unavailable"))?;
    Ok(WorkerChild {
        child,
        stdin,
        stdout,
        initialized: false,
    })
}

pub(super) async fn initialize(process: &mut WorkerChild, id: u64) -> CognitionResult<()> {
    let request = WorkerRequest {
        id,
        op: WorkerOperation::Initialize,
        texts: Vec::new(),
        checked: false,
        resplit: false,
        max_embeddings: None,
    };
    let mut frame =
        serde_json::to_vec(&request).map_err(|_| error("embed_worker_protocol_invalid"))?;
    frame.push(b'\n');
    let response = round_trip(process, &frame, id).await?;
    match response.result {
        WorkerResult::Ready => Ok(()),
        WorkerResult::Error { code } => Err(worker_error(&code)),
        _ => Err(error("embed_worker_protocol_invalid")),
    }
}

pub(super) async fn exchange(
    process: &mut WorkerChild,
    item: &Pending,
) -> CognitionResult<CognitionResult<NativeEmbeddingResult>> {
    let response = round_trip(process, &item.frame, item.id).await?;
    match response.result {
        WorkerResult::Embedding(result) => {
            validate_result(item, &result)?;
            Ok(Ok(*result))
        }
        WorkerResult::Error { code } => Ok(Err(worker_error(&code))),
        WorkerResult::Ready | WorkerResult::Tokenization(_) | WorkerResult::Closed => {
            Err(error("embed_worker_protocol_invalid"))
        }
    }
}

async fn round_trip(
    process: &mut WorkerChild,
    frame: &[u8],
    id: u64,
) -> CognitionResult<WorkerResponse> {
    process
        .stdin
        .write_all(frame)
        .await
        .map_err(|_| error("embed_worker_unavailable"))?;
    process
        .stdin
        .flush()
        .await
        .map_err(|_| error("embed_worker_unavailable"))?;
    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 8192];
    loop {
        let count = process
            .stdout
            .read(&mut chunk)
            .await
            .map_err(|_| error("embed_worker_unavailable"))?;
        if count == 0 || response.len() + count > MAX_RESPONSE_BYTES + 1 {
            return Err(error("embed_worker_protocol_invalid"));
        }
        response.extend_from_slice(&chunk[..count]);
        if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
            if newline + 1 != response.len() || newline > MAX_RESPONSE_BYTES {
                return Err(error("embed_worker_protocol_invalid"));
            }
            break;
        }
    }
    let response: WorkerResponse =
        serde_json::from_slice(&response).map_err(|_| error("embed_worker_protocol_invalid"))?;
    if response.id != id {
        return Err(error("embed_worker_protocol_invalid"));
    }
    Ok(response)
}

fn validate_result(item: &Pending, result: &NativeEmbeddingResult) -> CognitionResult<()> {
    let metadata = &result.metadata;
    let expected_pooling = match item.mode {
        EmbeddingMode::CheckedCls => "cls",
        EmbeddingMode::LegacyMean => "attention-mask-mean",
    };
    let expected_truncation = match item.mode {
        EmbeddingMode::CheckedCls => "strict-error-over-max",
        EmbeddingMode::LegacyMean => "postprocess-right-to-max-tokens",
    };
    let expected_count = item
        .max_embeddings
        .unwrap_or(item.requested_texts)
        .min(item.requested_texts);
    if metadata.schema != "butler.native-embedding-identity.v1"
        || metadata.pooling != expected_pooling
        || metadata.truncation != expected_truncation
        || metadata.dimension != 1024
        || metadata.version.len() != 64
        || result.embeddings.len() != result.token_counts.len()
        || (!item.resplit && result.embeddings.len() != expected_count)
        || result.embeddings.iter().any(|vector| {
            vector.len() != metadata.dimension || vector.iter().any(|value| !value.is_finite())
        })
    {
        return Err(error("embed_worker_protocol_invalid"));
    }
    if item.resplit {
        if result.embedded_texts.as_ref().map(Vec::len) != Some(result.embeddings.len())
            || result.omitted_count.is_none()
        {
            return Err(error("embed_worker_protocol_invalid"));
        }
    } else if result.embedded_texts.is_some() || result.omitted_count.is_some() {
        return Err(error("embed_worker_protocol_invalid"));
    }
    Ok(())
}

pub(super) async fn kill_and_reap(child: &mut Option<WorkerChild>) {
    if let Some(mut process) = child.take() {
        let _ = process.child.start_kill();
        let _ = process.child.wait().await;
    }
}

fn worker_error(code: &str) -> CognitionError {
    let code = match code {
        "embed_asset_path_unsafe" => "embed_asset_path_unsafe",
        "embed_asset_unavailable" => "embed_asset_unavailable",
        "embed_asset_download_failed" => "embed_asset_download_failed",
        "embed_asset_range_invalid" => "embed_asset_range_invalid",
        "embed_asset_hash_mismatch" => "embed_asset_hash_mismatch",
        "embed_asset_version_conflict" => "embed_asset_version_conflict",
        "embed_tokenizer_unavailable" => "embed_tokenizer_unavailable",
        "embed_tokenizer_limit_unavailable" => "embed_tokenizer_limit_unavailable",
        "embed_model_unavailable" => "embed_model_unavailable",
        "embed_model_input_unsupported" => "embed_model_input_unsupported",
        "embed_identity_invalid" => "embed_identity_invalid",
        "embed_invalid_request" => "embed_invalid_request",
        "embed_request_too_large" => "embed_request_too_large",
        "embed_response_too_large" => "embed_response_too_large",
        "embed_input_too_long" => "embed_input_too_long",
        "embed_grapheme_too_long" => "embed_grapheme_too_long",
        "embed_resplit_limit" => "embed_resplit_limit",
        "embed_tokenization_failed" => "embed_tokenization_failed",
        "embed_inference_failed" => "embed_inference_failed",
        "embed_output_invalid" => "embed_output_invalid",
        "embed_dimension_invalid" => "embed_dimension_invalid",
        _ => "embed_worker_protocol_invalid",
    };
    error(code)
}
