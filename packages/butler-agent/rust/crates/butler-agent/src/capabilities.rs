//! Native named capability lookup and public read-file projection.
mod arguments;
mod catalog;
mod cursor;
mod edit_file;
mod evidence;
mod grep_files;
mod list_files;
mod list_skills;
mod mutation_evidence;
mod read_file;
mod write_file;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::skills::Skills;
use crate::workspace::{WorkspaceFiles, WorkspaceMutations, WorkspaceReference};

pub(crate) use catalog::{
    BridgeCatalogTool, CatalogError, ToolCatalog, describe_native, search_native,
    validate_native_arguments,
};

#[derive(Clone)]
pub(crate) struct Capabilities {
    files: Arc<WorkspaceFiles>,
    mutations: Arc<WorkspaceMutations>,
    skills: Arc<Skills>,
}

#[derive(Clone, Debug)]
pub(crate) struct CapabilityInvocation<'a> {
    pub call: &'a Value,
    pub workspace_reference: Option<&'a WorkspaceReference>,
    pub workspace_path: Option<&'a std::path::Path>,
    pub butler_data: &'a std::path::Path,
    pub protected_ledger_roots: &'a [PathBuf],
    pub allowed_tools_and_effects: Option<&'a [String]>,
    pub mutation_scope: Option<&'a [String]>,
    pub installation_root: Option<&'a std::path::Path>,
}

/// A file or skill capability failed. `code()` is the tool-result code (the
/// capability's own, or the workspace guard's reason); the source keeps the
/// underlying I/O, owner or JSON error.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{code}")]
pub(crate) struct CapabilityError {
    code: &'static str,
    #[source]
    source: Option<Arc<dyn std::error::Error + Send + Sync>>,
}

impl CapabilityError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    /// A capability failure caused by `source`, reported with `code`.
    pub(crate) fn caused(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            source: Some(Arc::new(source)),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

/// Wire equality: the same code (causes are diagnostic only).
impl PartialEq for CapabilityError {
    fn eq(&self, other: &Self) -> bool {
        self.code == other.code
    }
}

impl Eq for CapabilityError {}

impl Capabilities {
    pub(crate) fn with_skills(
        files: Arc<WorkspaceFiles>,
        mutations: Arc<WorkspaceMutations>,
        skills: Arc<Skills>,
    ) -> Self {
        Self {
            files,
            mutations,
            skills,
        }
    }
    pub(crate) fn definition(&self, name: &str) -> Option<Value> {
        match name {
            "read_file" => Some(read_file::definition()),
            "list_files" => Some(list_files::definition()),
            "grep_files" => Some(grep_files::definition()),
            "write_file" => Some(write_file::definition()),
            "edit_file" => Some(edit_file::definition()),
            "list_skills" => Some(list_skills::definition()),
            _ => None,
        }
    }
    pub(crate) async fn invoke(
        &self,
        name: &str,
        input: CapabilityInvocation<'_>,
    ) -> Result<Value, CapabilityError> {
        match name {
            "read_file" => read_file::execute(&self.files, input).await,
            "list_files" => list_files::execute(&self.files, input).await,
            "grep_files" => grep_files::execute(&self.files, input).await,
            "write_file" => write_file::execute(&self.mutations, input).await,
            "edit_file" => edit_file::execute(&self.mutations, input).await,
            "list_skills" => list_skills::execute(&self.skills, input).await,
            _ => Err(CapabilityError::new("unknown_capability")),
        }
    }
    pub(crate) fn registered_names(&self) -> &'static [&'static str] {
        &[
            "read_file",
            "write_file",
            "edit_file",
            "list_files",
            "grep_files",
            "list_skills",
        ]
    }
}

fn failure(error: &str, message: &str, recovery_hint: &str) -> Value {
    json!({ "ok": false, "error": error, "message": message, "recovery_hint": recovery_hint,
        "evidence_capability_receipts": evidence::limitation(error) })
}

#[cfg(test)]
mod tests;
