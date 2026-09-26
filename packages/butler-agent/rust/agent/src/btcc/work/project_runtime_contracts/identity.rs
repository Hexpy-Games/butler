use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedProjectWorkScope {
    pub app_project_id: String,
    pub ledger_project_id: String,
    pub ledger_root: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProjectWorkOperationKind {
    MutationCall,
    BindingRevision,
    CloseoutDiagnostic,
    Abandonment,
    LegacyImport,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectWorkOperationIdentity {
    pub kind: ProjectWorkOperationKind,
    pub id: String,
    pub request_sha256: String,
    pub mutation_call_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectWorkCanonicalLocation {
    pub session_head_work_id: Option<String>,
    pub binding_work_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectWorkBinding {
    pub binding_revision_id: String,
    pub turn_id: String,
    pub revision: u64,
    pub bound_at: String,
    pub is_current: bool,
}
