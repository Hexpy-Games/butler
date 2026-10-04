use std::{future::Future, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::btcc::{BtccError, PortFuture};
#[cfg(any(test, feature = "test-support"))]
use crate::btcc::{StateExecutionClaim, TurnRecord};

use super::super::contracts::{ModelRoundMessage, ModelRoundResult};
use super::super::ports::{ModelRoundError, ModelRoundPort};

/// Failures replaying a persisted operation result into a round.
#[derive(Clone, Debug, thiserror::Error)]
pub enum OperationResultError {
    /// The model round failed.
    #[error(transparent)]
    Model(ModelRoundError),
    /// A BTCC contract was violated.
    #[error(transparent)]
    Contract(BtccError),
}

pub(crate) type OperationResultFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, OperationResultError>> + Send + 'a>>;

/// Whether older tool results are replayed as references to their stored exact results.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayMode {
    Disabled,
    Available,
}

/// The replay mode and exact-read capability bound for a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExactResultReplaySelection {
    pub mode: ReplayMode,
    pub exact_read_capability: bool,
}

/// The turn (and Work/project scope) exact results are read within.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationResultScope {
    pub turn_id: String,
    pub turn_revision: u64,
    pub session_id: String,
    pub project_ref: Option<String>,
    pub work_id: Option<String>,
}

#[cfg(any(test, feature = "test-support"))]
pub trait TurnWorkScopePort: Send + Sync {
    fn initial_work_id<'a>(
        &'a self,
        turn: &'a TurnRecord,
        claim: &'a StateExecutionClaim,
    ) -> PortFuture<'a, Option<String>>;
}

/// Binds operation-result replay to a turn.
pub trait OperationResultRuntimeFactory: Send + Sync {
    /// The runtime for `scope`, or `None` when replay is unavailable.
    fn bind(
        &self,
        scope: OperationResultScope,
    ) -> Result<Option<Arc<dyn OperationResultRuntime>>, BtccError>;
}

/// Replays older tool results as references and serves exact reads.
pub trait OperationResultRuntime: Send + Sync {
    /// The replayed transcript of a round, starting delivery of new references.
    fn prepare<'a>(
        &'a self,
        round_id: &'a str,
        messages: &'a [ModelRoundMessage],
        model: &'a dyn ModelRoundPort,
        butler_data: Option<&'a str>,
    ) -> OperationResultFuture<'a, super::super::contracts::ReplayPreparation>;
    /// Acknowledges the references a round's accepted response saw.
    fn accepted<'a>(
        &'a self,
        round_id: &'a str,
        result: &'a ModelRoundResult,
    ) -> OperationResultFuture<'a, ()>;
    /// Releases the references of a failed round.
    fn failed<'a>(&'a self, round_id: &'a str) -> OperationResultFuture<'a, ()>;
    /// Serves the `read_operation_results` tool.
    fn read_tool<'a>(&'a self, args: &'a Map<String, Value>) -> PortFuture<'a, Value>;
    /// Serves the `list_operation_results` tool.
    fn list_tool<'a>(&'a self, args: &'a Map<String, Value>) -> PortFuture<'a, Value>;
    /// The references attached to a tool call's result message.
    fn references_for_call<'a>(
        &'a self,
        provider_tool_name: &'a str,
        journal_call_id: Option<&'a str>,
    ) -> PortFuture<'a, OperationResultMessageReferences>;
}

/// The model-facing reference to a stored exact tool result (persisted in transcripts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OperationResultReference {
    pub version: OperationResultReferenceVersion,
    pub kind: OperationResultKind,
    pub identity: OperationResultIdentity,
    pub integrity: OperationResultIntegrity,
    pub outcome: OperationResultOutcome,
    pub availability: OperationResultAvailability,
}

/// Schema tag of [`OperationResultReference`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OperationResultReferenceVersion {
    #[serde(rename = "butler.operation-result-reference.v1")]
    V1,
}

/// The reference kind tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationResultKind {
    OperationResult,
}

/// Which stored result a reference names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OperationResultIdentity {
    pub kind: StoredResultKind,
    pub result_ref: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
}

/// Whether a result is stored for the turn directly or attached to Work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredResultKind {
    Direct,
    Work,
}

/// Diagnostic digest and authoritative Work revision of a referenced result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OperationResultIntegrity {
    pub sha256: String,
    pub revision: Option<f64>,
}

/// The completed outcome a reference reports.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OperationResultOutcome {
    pub status: CompletedOnly,
    pub success: bool,
    pub verification: StoredExactAvailable,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

/// Only completed results are referenced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletedOnly {
    Completed,
}

/// Referenced results are always stored exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredExactAvailable {
    StoredExactAvailable,
}

/// Whether and where the exact result can be read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OperationResultAvailability {
    pub status: ExactReadAvailability,
    pub capability: ReadOperationResultsOnly,
    pub scope: ExactReadScope,
}

/// Whether the exact result is readable or only referenced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExactReadAvailability {
    ExactReadAvailable,
    ReferenceOnly,
}
/// The only capability that reads exact results.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOperationResultsOnly {
    ReadOperationResults,
}
/// Where an exact read is allowed from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExactReadScope {
    SameTurn,
    WorkScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExactReadSource {
    Request,
    Result,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExactReadArguments {
    pub source: ExactReadSource,
    pub result_ref: String,
    pub sha256: String,
    pub revision: Option<f64>,
    pub work_id: Option<String>,
    pub offset: usize,
    pub length: usize,
}

/// The `read_operation_results` arguments that read a referenced result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExactReadArgumentsWire {
    pub result_ref: String,
    pub sha256: String,
    pub revision: Option<f64>,
    pub work_id: Option<String>,
    pub offset: usize,
    pub length: usize,
}

/// How the model reads the exact result behind a tool result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResultExactReadReference {
    pub capability: ReadOperationResultsOnly,
    pub arguments: ExactReadArgumentsWire,
    pub total_bytes: usize,
}

/// The references attached to a tool result message.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OperationResultMessageReferences {
    pub operation_result_call_id: Option<String>,
    pub reference: Option<OperationResultReference>,
    pub exact_read: Option<ToolResultExactReadReference>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct OperationResultListOutput {
    pub through: f64,
    pub next_cursor: Option<f64>,
    pub entries: Vec<OperationResultListEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct OperationResultListEntry {
    pub tool_name: String,
    pub status: String,
    pub started_at: String,
    pub request_preview: String,
    pub exact_read: ExactReadArgumentsWire,
}
