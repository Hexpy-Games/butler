//! Contracts between the effect service and its write/edit adapters.

use super::*;

/// The access an effect executes under; only full access dispatches effects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Full,
}
/// How an effect must be bound to the reviewed plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanBinding {
    ExactAction,
    AcceptedPlan,
}
/// How a legacy blocker relates to the current effect's target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockerRelation {
    Unrelated,
    Overlapping,
    Equivalent,
    Ambiguous,
}
/// An adapter-reported failure, with whether retrying may help.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectAdapterError {
    pub code: String,
    pub message: String,
    pub recoverable: Option<bool>,
}
impl EffectAdapterError {
    /// An error whose recoverability the adapter did not state.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: None,
        }
    }
}
/// What an adapter observed or did for an effect.
#[derive(Clone, Debug, PartialEq)]
pub enum AdapterOutcome {
    Applied(JsonDocument),
    NotApplied(EffectAdapterError),
    Uncertain(Option<EffectAdapterError>),
}
/// A validated workspace file write ready for the registered write port.
#[derive(Clone, Debug)]
pub struct PreparedWrite {
    pub path: String,
    pub content: String,
    pub create_parents: bool,
    pub overwrite: bool,
    pub expected_sha256: Option<String>,
}
/// Performs a registered workspace file write and returns its receipt.
pub trait RegisteredWritePort: Send + Sync {
    /// Writes the file and returns the registered receipt (passthrough JSON).
    fn write(&self, prepared: PreparedWrite) -> EffectFuture<'_, Value>;
}
/// Performs a registered workspace file edit and returns its receipt.
pub trait RegisteredEditPort: Send + Sync {
    /// Applies the normalized edit (passthrough JSON) and returns its receipt.
    fn edit(&self, prepared: Value) -> EffectFuture<'_, Value>;
}
/// One effect capability: normalizes targets and inputs, dispatches once
/// per idempotency key and reconciles an earlier dispatch after a restart.
pub trait EffectAdapter: Send + Sync {
    /// The capability name effects of this adapter are journaled under.
    fn capability(&self) -> &str;
    /// How the adapter's effects bind to the plan (the exact action by default).
    fn binding(&self) -> PlanBinding {
        PlanBinding::ExactAction
    }
    /// The canonical target used in the effect identity.
    fn normalize_target(&self, target: &str) -> EffectResult<String>;
    /// The target as it may be shown publicly.
    fn sanitize_target(&self, target: &str) -> EffectResult<String>;
    /// The canonical input used in the effect identity.
    fn normalize_input(&self, input: &Value) -> EffectResult<Value>;
    /// What reconciliation needs to recognize this input's write, if anything.
    fn recovery_hint(&self, _input: &Value) -> EffectResult<Option<RecoveryHint>> {
        Ok(None)
    }
    /// How a legacy blocker relates to the current target and input.
    fn classify<'a>(
        &'a self,
        _blocker: &'a EffectBlocker,
        _target: &'a str,
        _input: &'a Value,
    ) -> Option<EffectFuture<'a, BlockerRelation>> {
        None
    }
    /// Performs the effect once for `key`.
    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome>;
    /// Observes whether an earlier dispatch for `key` was applied.
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

/// A request to execute one effect for a Work under its access and signal.
pub struct ExecuteEffect {
    pub work: WorkView,
    pub access: Access,
    pub occurrence_id: Option<String>,
    pub signal: CancellationToken,
    pub target: String,
    pub input: Value,
    pub adapter: Arc<dyn EffectAdapter>,
}
/// The journaled facts behind an uncertain outcome.
#[derive(Clone, Debug, PartialEq)]
pub struct UncertainEvidence {
    pub effect_id: String,
    pub identity_sha256: String,
    pub dispatch_attempt: i64,
    pub error_code: String,
}
/// The settled outcome of executing an effect.
#[derive(Clone, Debug, PartialEq)]
pub enum EffectOutcome {
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

pub(crate) trait EffectFaultHook: Send + Sync {
    fn reached<'a>(
        &'a self,
        point: &'static str,
        identity: &'a EffectIdentity,
    ) -> EffectFuture<'a, ()>;
}
pub(crate) struct NoEffectFault;
impl EffectFaultHook for NoEffectFault {
    fn reached<'a>(
        &'a self,
        _point: &'static str,
        _identity: &'a EffectIdentity,
    ) -> EffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}
