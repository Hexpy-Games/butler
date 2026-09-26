use std::{future::Future, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::btcc::{BtccError, PortFuture};
#[cfg(test)]
use crate::btcc::{StateExecutionClaim, TurnRecord};

use super::super::contracts::{ModelRoundMessage, ModelRoundResult};
use super::super::ports::{ModelRoundError, ModelRoundPort};

#[derive(Clone, Debug)]
pub(crate) enum OperationResultError {
    Model(ModelRoundError),
    Contract(BtccError),
}

pub(crate) type OperationResultFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, OperationResultError>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReplayMode {
    Disabled,
    Available,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ExactResultReplaySelection {
    pub mode: ReplayMode,
    pub exact_read_capability: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OperationResultScope {
    pub turn_id: String,
    pub turn_revision: u64,
    pub session_id: String,
    pub project_ref: Option<String>,
    pub work_id: Option<String>,
}

#[cfg(test)]
pub(crate) trait TurnWorkScopePort: Send + Sync {
    fn initial_work_id<'a>(
        &'a self,
        turn: &'a TurnRecord,
        claim: &'a StateExecutionClaim,
    ) -> PortFuture<'a, Option<String>>;
}

pub(crate) trait OperationResultRuntimeFactory: Send + Sync {
    fn bind(
        &self,
        scope: OperationResultScope,
    ) -> Result<Option<Arc<dyn OperationResultRuntime>>, BtccError>;
}

pub(crate) trait OperationResultRuntime: Send + Sync {
    fn prepare<'a>(
        &'a self,
        round_id: &'a str,
        messages: &'a [ModelRoundMessage],
        model: &'a dyn ModelRoundPort,
        butler_data: Option<&'a str>,
    ) -> OperationResultFuture<'a, super::super::contracts::ReplayPreparation>;
    fn accepted<'a>(
        &'a self,
        round_id: &'a str,
        result: &'a ModelRoundResult,
    ) -> OperationResultFuture<'a, ()>;
    fn failed<'a>(&'a self, round_id: &'a str) -> OperationResultFuture<'a, ()>;
    fn read_tool<'a>(&'a self, args: &'a Map<String, Value>) -> PortFuture<'a, Value>;
    fn list_tool<'a>(&'a self, args: &'a Map<String, Value>) -> PortFuture<'a, Value>;
    fn references_for_call<'a>(
        &'a self,
        provider_tool_name: &'a str,
        journal_call_id: Option<&'a str>,
    ) -> PortFuture<'a, OperationResultMessageReferences>;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct OperationResultReference {
    pub version: OperationResultReferenceVersion,
    pub kind: OperationResultKind,
    pub identity: OperationResultIdentity,
    pub integrity: OperationResultIntegrity,
    pub outcome: OperationResultOutcome,
    pub availability: OperationResultAvailability,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum OperationResultReferenceVersion {
    #[serde(rename = "butler.operation-result-reference.v1")]
    V1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationResultKind {
    OperationResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct OperationResultIdentity {
    pub kind: StoredResultKind,
    pub result_ref: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StoredResultKind {
    Direct,
    Work,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct OperationResultIntegrity {
    pub sha256: String,
    pub revision: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct OperationResultOutcome {
    pub status: CompletedOnly,
    pub success: bool,
    pub verification: StoredExactAvailable,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CompletedOnly {
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StoredExactAvailable {
    StoredExactAvailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct OperationResultAvailability {
    pub status: ExactReadAvailability,
    pub capability: ReadOperationResultsOnly,
    pub scope: ExactReadScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExactReadAvailability {
    ExactReadAvailable,
    ReferenceOnly,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReadOperationResultsOnly {
    ReadOperationResults,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExactReadScope {
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ExactReadArgumentsWire {
    pub result_ref: String,
    pub sha256: String,
    pub revision: Option<f64>,
    pub work_id: Option<String>,
    pub offset: usize,
    pub length: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ToolResultExactReadReference {
    pub capability: ReadOperationResultsOnly,
    pub arguments: ExactReadArgumentsWire,
    pub total_bytes: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct OperationResultMessageReferences {
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
