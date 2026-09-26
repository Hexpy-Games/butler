use std::{borrow::Cow, future::Future, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::btcc::BtccSource;
use crate::btcc::work::WorkView;
use crate::json::JsonDocument;

mod fault;
pub(crate) use fault::{EffectFaultHook, NoEffectFault};

pub(crate) type EffectResult<T> = Result<T, EffectFailure>;
pub(crate) type EffectFuture<'a, T> = Pin<Box<dyn Future<Output = EffectResult<T>> + Send + 'a>>;

/// Failures of guided effect admission, journaling and adapters.
///
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum EffectFailure {
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
    pub(crate) fn policy(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
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

    pub(crate) fn adapter(message: impl Into<String>) -> Self {
        Self::Adapter {
            message: message.into(),
            source: None,
        }
    }

    /// Records `cause` as the source when none is recorded yet.
    #[must_use]
    pub(crate) fn with_source(
        mut self,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        let (Self::Policy { source, .. }
        | Self::Storage { source, .. }
        | Self::Adapter { source, .. }) = &mut self;
        if source.is_none() {
            *source = Some(Arc::new(cause));
        }
        self
    }

    pub(crate) fn code(&self) -> &str {
        match self {
            Self::Policy { code, .. } | Self::Storage { code, .. } => code,
            Self::Adapter { .. } => "effect_adapter_exception",
        }
    }

    pub(crate) fn message(&self) -> &str {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectError {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectIdentity {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EffectStatus {
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectReceipt {
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
    pub dispatch_attempt: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RecoveryHint {
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryEntry {
    pub path: String,
    pub start_line: i64,
    pub before_sha256: String,
    pub after_sha256: String,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EffectRecord {
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
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EffectBlocker {
    pub blocker_id: String,
    pub source_turn_id: String,
    pub source_occurrence_id: String,
    pub work_id: String,
    pub capability: String,
    pub target: String,
    pub input: Value,
    pub input_sha256: String,
    pub idempotency_key: String,
    pub detail: String,
    pub status: String,
    pub resolution: Option<String>,
    pub created_at: String,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PrepareEffect {
    Ready {
        created: bool,
        record: Box<EffectRecord>,
    },
    Conflict(String),
}

pub(crate) trait EffectJournal: Send + Sync {
    fn prepare(
        &self,
        identity: EffectIdentity,
        recovery: Option<RecoveryHint>,
    ) -> EffectFuture<'_, PrepareEffect>;
    fn find(&self, effect_id: String) -> EffectFuture<'_, Option<EffectRecord>>;
    fn list_for_work(
        &self,
        work_id: String,
        limit: Option<f64>,
    ) -> EffectFuture<'_, Vec<EffectRecord>>;
    fn blockers(&self, work_id: String) -> EffectFuture<'_, Vec<EffectBlocker>>;
    fn resolve_blockers(
        &self,
        work_id: String,
        occurrence: String,
        resolution: String,
    ) -> EffectFuture<'_, bool>;
    fn claim_dispatch(
        &self,
        effect_id: String,
        revision: i64,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    fn return_prepared(
        &self,
        effect_id: String,
        revision: i64,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    fn record_applied(
        &self,
        effect_id: String,
        revision: i64,
        result: JsonDocument,
        receipt: EffectReceipt,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    fn record_uncertain(
        &self,
        effect_id: String,
        revision: i64,
        error: EffectError,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
    fn record_failed(
        &self,
        effect_id: String,
        revision: i64,
        error: EffectError,
    ) -> EffectFuture<'_, Option<EffectRecord>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    Full,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanBinding {
    ExactAction,
    AcceptedPlan,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BlockerRelation {
    Unrelated,
    Overlapping,
    Equivalent,
    Ambiguous,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EffectAdapterError {
    pub code: String,
    pub message: String,
    pub recoverable: Option<bool>,
}
impl EffectAdapterError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: None,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum AdapterOutcome {
    Applied(JsonDocument),
    NotApplied(EffectAdapterError),
    Uncertain(Option<EffectAdapterError>),
}
#[derive(Clone, Debug)]
pub(crate) struct PreparedWrite {
    pub path: String,
    pub content: String,
    pub create_parents: bool,
    pub overwrite: bool,
    pub expected_sha256: Option<String>,
}
pub(crate) trait RegisteredWritePort: Send + Sync {
    fn write(&self, prepared: PreparedWrite) -> EffectFuture<'_, Value>;
}
pub(crate) trait RegisteredEditPort: Send + Sync {
    fn edit(&self, prepared: Value) -> EffectFuture<'_, Value>;
}
pub(crate) trait EffectAdapter: Send + Sync {
    fn capability(&self) -> &str;
    fn binding(&self) -> PlanBinding {
        PlanBinding::ExactAction
    }
    fn normalize_target(&self, target: &str) -> EffectResult<String>;
    fn sanitize_target(&self, target: &str) -> EffectResult<String>;
    fn normalize_input(&self, input: &Value) -> EffectResult<Value>;
    fn recovery_hint(&self, _input: &Value) -> EffectResult<Option<RecoveryHint>> {
        Ok(None)
    }
    fn classify<'a>(
        &'a self,
        _blocker: &'a EffectBlocker,
        _target: &'a str,
        _input: &'a Value,
    ) -> Option<EffectFuture<'a, BlockerRelation>> {
        None
    }
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome>;
    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        key: &'a str,
        signal: &'a CancellationToken,
        attempts: i64,
        prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome>;
}

pub(crate) struct ExecuteEffect {
    pub work: WorkView,
    pub access: Access,
    pub occurrence_id: Option<String>,
    pub signal: CancellationToken,
    pub target: String,
    pub input: Value,
    pub adapter: Arc<dyn EffectAdapter>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UncertainEvidence {
    pub effect_id: String,
    pub identity_sha256: String,
    pub dispatch_attempt: i64,
    pub error_code: String,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum EffectOutcome {
    Applied {
        replayed: bool,
        result: JsonDocument,
        receipt: Box<EffectReceipt>,
    },
    Rejected(EffectError),
    Failed(EffectError),
    Uncertain {
        error: EffectError,
        evidence: Option<UncertainEvidence>,
    },
}
