//! Bounded private-worker process and stdio framing.

use std::process::Stdio;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use butler_memory::cognition::{
    CognitionError, CognitionResult, EmbeddingMode, EmbeddingResult, WorkerOperation,
    WorkerRequest, WorkerResponse, WorkerResult,
};

use super::{error, queue::Pending};
use butler_memory::cognition::CognitionCode;

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct WorkerChild {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: ChildStdout,
    pub(super) initialized: bool,
}

pub(super) async fn spawn_worker(
    executable: &std::path::Path,
    data_root: &std::path::Path,
) -> CognitionResult<WorkerChild> {
    let role = butler_platform::process_names::Role::Memory;
    let executable = butler_platform::process_names::executable_async(executable, role)
        .await
        .map_err(|source| error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?;
    let mut command = Command::new(executable);
    butler_platform::process_names::name_command(command.as_std_mut(), role);
    let mut child = command
        .arg("--private-embedding-worker")
        .env("BUTLER_DATA", data_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|source| error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| error(CognitionCode::EmbedWorkerUnavailable))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| error(CognitionCode::EmbedWorkerUnavailable))?;
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
    let mut frame = serde_json::to_vec(&request)
        .map_err(|source| error(CognitionCode::EmbedWorkerProtocolInvalid).with_source(source))?;
    frame.push(b'\n');
    let response = round_trip(process, &frame, id).await?;
    match response.result {
        WorkerResult::Ready => Ok(()),
        WorkerResult::Error { code } => Err(worker_error(&code)),
        _ => Err(error(CognitionCode::EmbedWorkerProtocolInvalid)),
    }
}

pub(super) async fn exchange(
    process: &mut WorkerChild,
    item: &Pending,
) -> CognitionResult<CognitionResult<EmbeddingResult>> {
    let response = round_trip(process, &item.frame, item.id).await?;
    match response.result {
        WorkerResult::Embedding(result) => {
            validate_result(item, &result)?;
            Ok(Ok(*result))
        }
        WorkerResult::Error { code } => Ok(Err(worker_error(&code))),
        WorkerResult::Ready | WorkerResult::Tokenization(_) | WorkerResult::Closed => {
            Err(error(CognitionCode::EmbedWorkerProtocolInvalid))
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
        .map_err(|source| error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?;
    process
        .stdin
        .flush()
        .await
        .map_err(|source| error(CognitionCode::EmbedWorkerUnavailable).with_source(source))?;
    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 8192];
    loop {
        let count =
            process.stdout.read(&mut chunk).await.map_err(|source| {
                error(CognitionCode::EmbedWorkerUnavailable).with_source(source)
            })?;
        if count == 0 || response.len() + count > MAX_RESPONSE_BYTES + 1 {
            return Err(error(CognitionCode::EmbedWorkerProtocolInvalid));
        }
        response.extend_from_slice(&chunk[..count]);
        if let Some(newline) = response.iter().position(|byte| *byte == b'\n') {
            if newline + 1 != response.len() || newline > MAX_RESPONSE_BYTES {
                return Err(error(CognitionCode::EmbedWorkerProtocolInvalid));
            }
            break;
        }
    }
    let response: WorkerResponse = serde_json::from_slice(&response)
        .map_err(|source| error(CognitionCode::EmbedWorkerProtocolInvalid).with_source(source))?;
    if response.id != id {
        return Err(error(CognitionCode::EmbedWorkerProtocolInvalid));
    }
    Ok(response)
}

fn validate_result(item: &Pending, result: &EmbeddingResult) -> CognitionResult<()> {
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
        return Err(error(CognitionCode::EmbedWorkerProtocolInvalid));
    }
    if item.resplit {
        if result.embedded_texts.as_ref().map(Vec::len) != Some(result.embeddings.len())
            || result.omitted_count.is_none()
        {
            return Err(error(CognitionCode::EmbedWorkerProtocolInvalid));
        }
    } else if result.embedded_texts.is_some() || result.omitted_count.is_some() {
        return Err(error(CognitionCode::EmbedWorkerProtocolInvalid));
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
        "embed_asset_path_unsafe" => CognitionCode::EmbedAssetPathUnsafe,
        "embed_asset_unavailable" => CognitionCode::EmbedAssetUnavailable,
        "embed_asset_download_failed" => CognitionCode::EmbedAssetDownloadFailed,
        "embed_asset_range_invalid" => CognitionCode::EmbedAssetRangeInvalid,
        "embed_asset_hash_mismatch" => CognitionCode::EmbedAssetHashMismatch,
        "embed_asset_version_conflict" => CognitionCode::EmbedAssetVersionConflict,
        "embed_tokenizer_unavailable" => CognitionCode::EmbedTokenizerUnavailable,
        "embed_tokenizer_limit_unavailable" => CognitionCode::EmbedTokenizerLimitUnavailable,
        "embed_model_unavailable" => CognitionCode::EmbedModelUnavailable,
        "embed_model_input_unsupported" => CognitionCode::EmbedModelInputUnsupported,
        "embed_identity_invalid" => CognitionCode::EmbedIdentityInvalid,
        "embed_invalid_request" => CognitionCode::EmbedInvalidRequest,
        "embed_request_too_large" => CognitionCode::EmbedRequestTooLarge,
        "embed_response_too_large" => CognitionCode::EmbedResponseTooLarge,
        "embed_input_too_long" => CognitionCode::EmbedInputTooLong,
        "embed_grapheme_too_long" => CognitionCode::EmbedGraphemeTooLong,
        "embed_resplit_limit" => CognitionCode::EmbedResplitLimit,
        "embed_tokenization_failed" => CognitionCode::EmbedTokenizationFailed,
        "embed_inference_failed" => CognitionCode::EmbedInferenceFailed,
        "embed_output_invalid" => CognitionCode::EmbedOutputInvalid,
        "embed_dimension_invalid" => CognitionCode::EmbedDimensionInvalid,
        _ => CognitionCode::EmbedWorkerProtocolInvalid,
    };
    error(code)
}
