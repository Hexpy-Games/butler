use super::super::{StorageError, StorageResult};
use crate::btcc::StorageCode;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub(crate) type ExactProjectWorkResultAuthorityFuture<'a> = Pin<
    Box<dyn Future<Output = StorageResult<Arc<dyn ExactProjectWorkResultAuthority>>> + Send + 'a>,
>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectWorkResultAuthorityLocation {
    pub work_id: String,
    pub app_project_id: String,
    pub ledger_project_id: String,
}

pub(crate) trait ProjectWorkResultAuthorityFactory: Send + Sync {
    fn prepare(
        &self,
        location: ProjectWorkResultAuthorityLocation,
    ) -> ExactProjectWorkResultAuthorityFuture<'_>;
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExactProjectWorkResultIdentity {
    pub result_ref: String,
    pub revision: f64,
    pub work_id: String,
    pub session_id: String,
    pub scope_ref: String,
    pub ledger_project_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub turn_id: String,
    pub result_sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExactProjectWorkResultVerification {
    pub result_ref: String,
    pub revision: f64,
    pub work_id: String,
    pub session_id: String,
    pub scope_ref: String,
    pub ledger_project_id: String,
    pub tool_call_id: String,
    pub turn_id: String,
    pub result_sha256: String,
}

pub(crate) trait ExactProjectWorkResultAuthority: Send + Sync {
    fn resolve(
        &self,
        input: &OperationResultReferenceInput,
    ) -> StorageResult<Option<ExactProjectWorkResultIdentity>>;
    fn verify(
        &self,
        input: &ExactProjectWorkResultVerification,
    ) -> StorageResult<ExactProjectWorkResultIdentity>;
}

#[derive(Clone, Debug)]
pub(crate) struct OperationResultDiscoveryInput {
    pub turn_id: String,
    pub work_id: Option<String>,
    pub cursor: f64,
    pub through: Option<f64>,
    pub query: String,
    pub tool_name: Option<String>,
    pub status: Option<String>,
    pub limit: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OperationResultDiscoveryEntry {
    pub call_id: String,
    pub origin_turn_id: String,
    pub ordinal: f64,
    pub tool_name: String,
    pub status: String,
    pub started_at: String,
    pub request_preview: String,
    pub result_sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OperationResultDiscovery {
    pub entries: Vec<OperationResultDiscoveryEntry>,
    pub through: f64,
    pub next_cursor: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct OperationResultReferenceInput {
    pub turn_id: String,
    pub call_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OperationResultReference {
    pub kind: &'static str,
    pub result_ref: String,
    pub revision: Option<f64>,
    pub work_id: Option<String>,
    pub session_id: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExactResultSource {
    Request,
    Result,
}

#[derive(Clone, Debug)]
pub(crate) struct ExactResultRangeInput {
    pub turn_id: String,
    pub result_ref: String,
    pub result_sha256: String,
    pub revision: Option<f64>,
    pub session_id: Option<String>,
    pub project_ref: Option<String>,
    pub work_id: Option<String>,
    pub offset: usize,
    pub length: usize,
    pub source: ExactResultSource,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExactResultRange {
    pub encoding: &'static str,
    pub data: String,
    pub offset: usize,
    pub length: usize,
    pub total_bytes: usize,
    pub next_offset: Option<usize>,
    pub result_sha256: String,
    pub complete: bool,
}

pub(super) fn error(code: StorageCode) -> StorageError {
    StorageError::new(code, code.as_str())
}
