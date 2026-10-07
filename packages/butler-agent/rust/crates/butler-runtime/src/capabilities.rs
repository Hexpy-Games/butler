//! The built-in file tools (read, list, grep, write, edit) and the tool catalog
//! that validates their model-facing definitions.
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
mod skill_tools;
mod write_file;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::skills::Skills;
use butler_turn::workspace::{WorkspaceFiles, WorkspaceMutations, WorkspaceReference};

pub use catalog::{
    BridgeCatalogTool, CatalogError, ToolCatalog, describe_native, search_native,
    validate_native_arguments,
};

#[derive(Clone)]
pub struct Capabilities {
    files: Arc<WorkspaceFiles>,
    mutations: Arc<WorkspaceMutations>,
    skills: Arc<Skills>,
}

#[derive(Clone, Debug)]
pub struct CapabilityInvocation<'a> {
    pub contained: bool,
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
pub struct CapabilityError {
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

    pub fn code(&self) -> &'static str {
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
    pub async fn compact_skill_catalog(
        &self,
        project_id: Option<String>,
    ) -> Result<String, CapabilityError> {
        self.skills
            .compact_catalog(project_id)
            .await
            .map_err(|error| CapabilityError::caused(error.code(), error))
    }
    pub fn with_skills(
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
            "load_skill" => Some(skill_tools::load_definition()),
            "read_skill_file" => Some(skill_tools::read_definition()),
            _ => None,
        }
    }
    pub async fn invoke(
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
            "load_skill" => skill_tools::load(&self.skills, input).await,
            "read_skill_file" => skill_tools::read(&self.skills, &self.files, input).await,
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
            "load_skill",
            "read_skill_file",
        ]
    }
}

fn failure(error: &str, message: &str, recovery_hint: &str) -> Value {
    json!({ "ok": false, "error": error, "message": message, "recovery_hint": recovery_hint,
        "evidence_capability_receipts": evidence::limitation(error) })
}

mod registered_write;
#[cfg(any(test, feature = "test-support"))]
mod testing;
#[cfg(test)]
mod tests;
pub use registered_write::{RegisteredWrite, RegisteredWriteContext};
