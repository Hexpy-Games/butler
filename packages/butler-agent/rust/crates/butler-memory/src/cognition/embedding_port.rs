//! Cognition's typed embedding need and the private same-binary wire contract.
//! Host owns the child process; Cognition chooses the vector policy.

use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::{CognitionResult, EmbeddingResult, Tokenization};

/// How texts are embedded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddingMode {
    /// Mean pooling over the attention mask, truncating long input (legacy vectors).
    LegacyMean,
    /// CLS pooling that refuses input longer than the model limit.
    CheckedCls,
}

/// Scheduling class of an embedding request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbeddingRequestClass {
    /// A user is waiting.
    Interactive,
    /// Background maintenance.
    Background,
}

/// Texts to embed.
pub struct EmbeddingRequest {
    /// The texts.
    pub texts: Vec<String>,
    /// Pooling and truncation mode.
    pub mode: EmbeddingMode,
    /// Split a text that is too long at grapheme boundaries instead of failing.
    pub resplit: bool,
    /// Embed at most this many texts; the rest are reported as omitted.
    pub max_embeddings: Option<usize>,
    /// Scheduling class.
    pub request_class: EmbeddingRequestClass,
    /// Give up after this time (milliseconds since the epoch).
    pub deadline_at_epoch_ms: Option<i64>,
}

/// The pending result of an embedding request.
pub type EmbeddingFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<EmbeddingResult>> + Send + 'a>>;

/// Embeds texts for memory projection and recall.
pub trait CognitionEmbeddingPort: Send + Sync {
    /// Embeds the request, or fails when cancelled.
    fn embed(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'_>;
}

/// A request to the embedding worker process.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    /// Request id, echoed in the response.
    pub id: u64,
    /// What to do.
    pub op: WorkerOperation,
    /// Texts to embed or tokenize.
    #[serde(default)]
    pub texts: Vec<String>,
    /// Use checked CLS pooling.
    #[serde(default)]
    pub checked: bool,
    /// Split texts that are too long.
    #[serde(default)]
    pub resplit: bool,
    /// Embed at most this many texts.
    pub max_embeddings: Option<usize>,
}

/// Operations of the embedding worker.
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOperation {
    /// Load the model.
    Initialize,
    /// Embed texts.
    Embed,
    /// Tokenize texts.
    Tokenize,
    /// Shut down.
    Close,
}

/// A response from the embedding worker.
#[derive(Deserialize, Serialize)]
pub struct WorkerResponse {
    /// Id of the request answered.
    pub id: u64,
    /// Outcome.
    #[serde(flatten)]
    pub result: WorkerResult,
}

/// Outcome of a worker request.
#[derive(Deserialize, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "snake_case")]
pub enum WorkerResult {
    /// The model is loaded.
    Ready,
    /// Embeddings.
    Embedding(Box<EmbeddingResult>),
    /// Token ids.
    Tokenization(Tokenization),
    /// The worker shut down.
    Closed,
    /// The request failed.
    Error {
        /// Failure code.
        code: String,
    },
}

impl WorkerResponse {
    /// A failed response to request `id`.
    pub fn error(id: u64, code: &'static str) -> Self {
        Self {
            id,
            result: WorkerResult::Error {
                code: code.to_owned(),
            },
        }
    }
}
