//! Cognition's typed embedding need and the private same-binary wire contract.
//! Host owns the child process; Cognition chooses the vector policy.

use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::{CognitionResult, NativeEmbeddingResult, NativeTokenization};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EmbeddingMode {
    LegacyMean,
    CheckedCls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EmbeddingRequestClass {
    Interactive,
    Background,
}

pub(crate) struct EmbeddingRequest {
    pub(crate) texts: Vec<String>,
    pub(crate) mode: EmbeddingMode,
    pub(crate) resplit: bool,
    pub(crate) max_embeddings: Option<usize>,
    pub(crate) request_class: EmbeddingRequestClass,
    pub(crate) deadline_at_epoch_ms: Option<i64>,
}

pub(crate) type EmbeddingFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<NativeEmbeddingResult>> + Send + 'a>>;

pub(crate) trait CognitionEmbeddingPort: Send + Sync {
    fn embed<'a>(
        &'a self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'a>;
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkerRequest {
    pub(crate) id: u64,
    pub(crate) op: WorkerOperation,
    #[serde(default)]
    pub(crate) texts: Vec<String>,
    #[serde(default)]
    pub(crate) checked: bool,
    #[serde(default)]
    pub(crate) resplit: bool,
    pub(crate) max_embeddings: Option<usize>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkerOperation {
    Initialize,
    Embed,
    Tokenize,
    Close,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct WorkerResponse {
    pub(crate) id: u64,
    #[serde(flatten)]
    pub(crate) result: WorkerResult,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "snake_case")]
pub(crate) enum WorkerResult {
    Ready,
    Embedding(Box<NativeEmbeddingResult>),
    Tokenization(NativeTokenization),
    Closed,
    Error { code: String },
}

impl WorkerResponse {
    pub(crate) fn error(id: u64, code: &'static str) -> Self {
        Self {
            id,
            result: WorkerResult::Error {
                code: code.to_owned(),
            },
        }
    }
}
