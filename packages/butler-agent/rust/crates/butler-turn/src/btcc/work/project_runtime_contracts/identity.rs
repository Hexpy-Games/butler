use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A project resolved to its App and ledger ids.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedProjectWorkScope {
    pub app_project_id: String,
    pub ledger_project_id: String,
    pub ledger_root: PathBuf,
}

/// The kind of a project Work operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectWorkOperationKind {
    MutationCall,
    BindingRevision,
    CloseoutDiagnostic,
    Abandonment,
    LegacyImport,
}

/// Identifies a project Work operation and its request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectWorkOperationIdentity {
    pub kind: ProjectWorkOperationKind,
    pub id: String,
    pub request_sha256: String,
    pub mutation_call_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectWorkCanonicalLocation {
    pub session_head_work_id: Option<String>,
    pub binding_work_id: Option<String>,
}

/// A turn's binding revision to a project Work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkBinding {
    pub binding_revision_id: String,
    pub turn_id: String,
    pub revision: u64,
    pub bound_at: String,
    pub is_current: bool,
}
