//! Incremental consolidation-owned habit notes. No idle worker or model tools.
mod merge;
mod prompt;
mod service;
mod store;
mod types;
mod usage;
use butler_models::models::ReasoningEffort;
use chrono::{DateTime, Utc};
pub use service::PatternExtractionService;
use std::{future::Future, pin::Pin};
pub use store::PatternRepository;
use tokio_util::sync::CancellationToken;
pub use types::PatternEvent;
use types::PatternStore;

#[derive(Debug, thiserror::Error)]
/// Failures of pattern extraction, storage and explicit decisions.
pub enum PatternError {
    #[error("Pattern revision changed")]
    /// The user or another writer changed this revision.
    Conflict,
    #[error("Pattern not found")]
    /// The selected active pattern or candidate does not exist.
    NotFound,
    #[error("Memory writer is busy")]
    /// Another cognition writer owns the consolidation lease.
    Busy,
    #[error("Pattern extraction cancelled")]
    /// Cancellation or withdrawn learning consent stopped publication.
    Cancelled,
    #[error("Invalid pattern model reply")]
    /// The model did not return the requested JSON array.
    InvalidReply,
    #[error("Invalid pattern store")]
    /// The durable notes have an unsupported schema.
    InvalidStore,
    #[error("Invalid proposal decision")]
    /// Only acceptance and decline are supported.
    InvalidDecision,
    #[error("Pattern operation failed: {0}")]
    /// An existing source, provider or storage port failed.
    Port(#[source] Box<dyn std::error::Error + Send + Sync>),
}
impl PatternError {
    /// Preserve an underlying port failure without retaining user text.
    pub fn port(error: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Port(Box::new(error))
    }
    /// Stable wire/phase diagnostic code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Conflict => "pattern_revision_conflict",
            Self::NotFound => "pattern_not_found",
            Self::Busy => "memory_write_busy",
            Self::Cancelled => "pattern_extraction_cancelled",
            Self::InvalidReply => "pattern_reply_invalid",
            Self::InvalidStore => "pattern_store_invalid",
            Self::InvalidDecision => "pattern_decision_invalid",
            Self::Port(_) => "pattern_operation_failed",
        }
    }
    fn io(error: std::io::Error) -> Self {
        Self::port(error)
    }
    fn encoding(error: serde_json::Error) -> Self {
        Self::port(error)
    }
    fn worker(error: tokio::task::JoinError) -> Self {
        Self::port(error)
    }
    fn coordination(error: crate::coordination::CoordinationError) -> Self {
        Self::port(error)
    }
}
/// Async result returned by a pattern input port.
pub type PatternFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, PatternError>> + Send + 'a>>;
/// Consent is resolved before settings, store or source reads.
pub trait PatternInputSource: Send + Sync {
    /// Consent first: None disables the entire phase.
    fn learning_depth(&self) -> PatternFuture<'_, Option<String>>;
    /// Resolve consolidation model, locale, timezone and proactive level.
    fn settings(&self) -> PatternFuture<'_, PatternInput>;
    /// At most 200 user events, chronologically, starting at the given offset.
    fn page(&self, since: DateTime<Utc>, offset: usize) -> PatternFuture<'_, Vec<PatternEvent>>;
}
/// Current settings for one extraction run.
pub struct PatternInput {
    /// Consented depth: basic or deep.
    pub learning_depth: String,
    /// User language for model-authored notes.
    pub locale: String,
    /// Timezone describing the local event timestamps.
    pub timezone: String,
    /// Model evidence bar: off, sometimes or often.
    pub level: String,
    /// Canonical consolidation model reference.
    pub model: String,
    /// Catalog-resolved reasoning effort.
    pub reasoning: ReasoningEffort,
}
fn ensure_active(token: &CancellationToken) -> Result<(), PatternError> {
    if token.is_cancelled() {
        Err(PatternError::Cancelled)
    } else {
        Ok(())
    }
}
