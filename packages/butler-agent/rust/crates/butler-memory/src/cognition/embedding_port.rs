//! Cognition's typed embedding need and the private same-binary wire contract.
//! Host owns the child process; Cognition chooses the vector policy.

use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::{CognitionResult, EmbeddingResult, Tokenization};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddingMode {
    LegacyMean,
    CheckedCls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddingRequestClass {
    Interactive,
    Background,
}

pub struct EmbeddingRequest {
    pub texts: Vec<String>,
    pub mode: EmbeddingMode,
    pub resplit: bool,
    pub max_embeddings: Option<usize>,
    pub request_class: EmbeddingRequestClass,
    pub deadline_at_epoch_ms: Option<i64>,
}

pub type EmbeddingFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<EmbeddingResult>> + Send + 'a>>;

pub trait CognitionEmbeddingPort: Send + Sync {
    fn embed(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'_>;
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub id: u64,
    pub op: WorkerOperation,
    #[serde(default)]
    pub texts: Vec<String>,
    #[serde(default)]
    pub checked: bool,
    #[serde(default)]
    pub resplit: bool,
    pub max_embeddings: Option<usize>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOperation {
    Initialize,
    Embed,
    Tokenize,
    Close,
}

#[derive(Deserialize, Serialize)]
pub struct WorkerResponse {
    pub id: u64,
    #[serde(flatten)]
    pub result: WorkerResult,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "snake_case")]
pub enum WorkerResult {
    Ready,
    Embedding(Box<EmbeddingResult>),
    Tokenization(Tokenization),
    Closed,
    Error { code: String },
}

impl WorkerResponse {
    pub fn error(id: u64, code: &'static str) -> Self {
        Self {
            id,
            result: WorkerResult::Error {
                code: code.to_owned(),
            },
        }
    }
}
