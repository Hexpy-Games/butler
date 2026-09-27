use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::btcc::BtccSource;
use crate::btcc::work::WorkView;
use butler_core::json::JsonDocument;

mod adapter;
pub use adapter::*;

pub(crate) type EffectResult<T> = Result<T, EffectFailure>;
/// A boxed effect-journal or adapter operation.
pub type EffectFuture<'a, T> = Pin<Box<dyn Future<Output = EffectResult<T>> + Send + 'a>>;

/// Failures of guided effect admission, journaling and adapters.
///
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum EffectFailure {
    /// An effect policy check refused the effect (identity, target, blocker,
    /// recovery or input rules).
    #[error("{code}: {message}")]
    Policy {
        code: Cow<'static, str>,
        message: String,
        #[source]
        source: Option<BtccSource>,
    },
    /// Reading or writing the effect journal failed.
    #[error("{code}: {message}")]
    Storage {
        code: Cow<'static, str>,
        message: String,
        #[source]
        source: Option<BtccSource>,
    },
    /// An effect adapter raised instead of returning an outcome.
    #[error("effect_adapter_exception: {message}")]
    Adapter {
        message: String,
        #[source]
        source: Option<BtccSource>,
    },
}

impl EffectFailure {
    /// A refusal by effect policy with its wire code.
    pub fn policy(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::Policy {
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }

    pub(crate) fn storage(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::Storage {
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }

    /// A failure raised inside an effect adapter.
    pub fn adapter(message: impl Into<String>) -> Self {
        Self::Adapter {
            message: message.into(),
            source: None,
        }
    }

    /// Records `cause` as the source when none is recorded yet.
    #[must_use]
    pub fn with_source(mut self, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        let (Self::Policy { source, .. }
        | Self::Storage { source, .. }
        | Self::Adapter { source, .. }) = &mut self;
        if source.is_none() {
            *source = Some(Arc::new(cause));
        }
        self
    }

    /// The wire code (`effect_adapter_exception` for adapter failures).
    pub fn code(&self) -> &str {
        match self {
            Self::Policy { code, .. } | Self::Storage { code, .. } => code,
            Self::Adapter { .. } => "effect_adapter_exception",
        }
    }

    /// The human-readable message.
    pub fn message(&self) -> &str {
        match self {
            Self::Policy { message, .. }
            | Self::Storage { message, .. }
            | Self::Adapter { message, .. } => message,
        }
    }
}

/// Wire equality: the same variant, code and message (causes are diagnostic only).
impl PartialEq for EffectFailure {
    fn eq(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
            && self.code() == other.code()
            && self.message() == other.message()
    }
}

impl Eq for EffectFailure {}

impl From<crate::btcc::StorageError> for EffectFailure {
    fn from(error: crate::btcc::StorageError) -> Self {
        Self::Storage {
            code: error.code().into(),
            message: error.message(),
            source: Some(Arc::new(error)),
        }
    }
}

/// The model-facing error of an effect that failed or could not be confirmed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_code: Option<String>,
}
impl EffectError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: true,
            source_code: None,
        }
    }
}

/// The durable identity of one effect occurrence: ids, idempotency key and
/// the normalized target/input it was admitted for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectIdentity {
    pub effect_id: String,
    pub receipt_id: String,
    pub idempotency_key: String,
    pub identity_sha256: String,
    pub request_sha256: String,
    pub input_sha256: String,
    pub target_sha256: String,
    pub work_id: String,
    pub plan_revision_id: String,
    pub action_key: String,
    pub capability: String,
    pub sanitized_target: String,
}

/// The journal state of an effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectStatus {
    Prepared,
    Dispatching,
    Applied,
    Uncertain,
    Failed,
}
impl EffectStatus {
    pub(crate) fn parse(value: &str) -> EffectResult<Self> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "dispatching" => Ok(Self::Dispatching),
            "applied" => Ok(Self::Applied),
            "uncertain" => Ok(Self::Uncertain),
            "failed" => Ok(Self::Failed),
            _ => Err(EffectFailure::storage(
                "effect_journal_corrupt",
                "invalid status",
            )),
        }
    }
}

/// The receipt of an applied effect returned to the model.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectReceipt {
    pub effect_id: String,
    pub receipt_id: String,
    pub idempotency_key: String,
    pub identity_sha256: String,
    pub request_sha256: String,
    pub input_sha256: String,
    pub target_sha256: String,
    pub work_id: String,
    pub plan_revision_id: String,
    pub action_key: String,
    pub capability: String,
    pub sanitized_target: String,
    pub result: JsonDocument,
    pub applied_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    // Passthrough: tool/effect receipts, shaped by the capability.
    pub dispatch_attempt: Option<Value>,
}

/// What an adapter needs to recognize its own earlier write after a restart
/// (single or batched file edits).
#[derive(Clone, Debug, PartialEq)]
pub enum RecoveryHint {
    Single {
        capability: String,
        start_line: i64,
        before_sha256: String,
        after_sha256: String,
    },
    Batch {
        capability: String,
        entries: Vec<RecoveryEntry>,
    },
}
/// One file of a batched edit recovery hint.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub path: String,
    pub start_line: i64,
    pub before_sha256: String,
    pub after_sha256: String,
}
/// A journaled effect with its revision and dispatch history.
#[derive(Clone, Debug, PartialEq)]
pub struct EffectRecord {
    pub identity: EffectIdentity,
    pub status: EffectStatus,
    pub journal_revision: i64,
    pub dispatch_attempts: i64,
    // None means SQL NULL. Some(JsonDocument containing null) is present JSON null.
    pub result: Option<JsonDocument>,
    pub receipt: Option<EffectReceipt>,
    pub error: Option<EffectError>,
    pub recovery_hint: Option<RecoveryHint>,
    pub created_at: String,
    pub updated_at: String,
}
/// A legacy effect whose outcome must be settled before the Work may
/// dispatch an overlapping effect.
#[derive(Clone, Debug, PartialEq)]
pub struct EffectBlocker {
    pub blocker_id: String,
    pub source_turn_id: String,
    pub source_occurrence_id: String,
    pub work_id: String,
    pub capability: String,
    pub target: String,
    // Passthrough: EffectAdapter input is capability-generic tool input.
    pub input: Value,
    pub input_sha256: String,
    pub idempotency_key: String,
    pub detail: String,
    pub status: BlockerStatus,
    pub resolution: Option<String>,
    pub created_at: String,
}

/// Whether a legacy effect blocker's prior occurrence is known to have applied.
/// Stored as `unresolved` / `applied` in `btcc_guided_work_effect_blockers.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockerStatus {
    Unresolved,
    Applied,
}

impl BlockerStatus {
    /// Parses a stored status; other values are corrupt rows.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "unresolved" => Some(Self::Unresolved),
            "applied" => Some(Self::Applied),
            _ => None,
        }
    }
}
/// The outcome of preparing an effect in the journal.
#[derive(Clone, Debug, PartialEq)]
pub enum PrepareEffect {
    Ready {
        created: bool,
        record: Box<EffectRecord>,
    },
    Conflict(String),
}

/// Durable journal of guided effects; every state change is a revision-checked
/// transition so concurrent owners cannot both dispatch.
pub trait EffectJournal: Send + Sync {
    /// Records (or replays) the prepared effect for `identity`.
    fn prepare(
        &self,
        identity: EffectIdentity,
        recovery: Option<RecoveryHint>,
    ) -> EffectFuture<'_, PrepareEffect>;
    /// The journaled effect, if any.
    fn find(&self, effect_id: String) -> EffectFuture<'_, Option<EffectRecord>>;
    /// The Work's journaled effects, newest first, up to `limit`.
    fn list_for_work(
        &self,
        work_id: String,
        limit: Option<f64>,
    ) -> EffectFuture<'_, Vec<EffectRecord>>;
    /// The Work's unresolved and applied legacy blockers.
    fn blockers(&self, work_id: String) -> EffectFuture<'_, Vec<EffectBlocker>>;
    /// Resolves every blocker of a legacy occurrence as `applied` or `not_applied`.
    fn resolve_blockers(
        &self,
        work_id: String,
        occurrence: String,
        resolution: String,
    ) -> EffectFuture<'_, bool>;
    /// Moves a prepared effect at `revision` to dispatching; `None` if another
    /// owner changed it first.
    fn claim_dispatch(
        &self,
        effect_id: String,
        revision: i64,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    /// Returns a dispatching effect to prepared (permission was withdrawn).
    fn return_prepared(
        &self,
        effect_id: String,
        revision: i64,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    /// Records the adapter's applied result.
    fn record_applied(
        &self,
        effect_id: String,
        revision: i64,
        result: JsonDocument,
        receipt: EffectReceipt,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    /// Records that the outcome cannot yet be confirmed.
    fn record_uncertain(
        &self,
        effect_id: String,
        revision: i64,
        error: EffectError,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    /// Records that the adapter reported the effect not applied.
    fn record_failed(
        &self,
        effect_id: String,
        revision: i64,
        error: EffectError,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
}
