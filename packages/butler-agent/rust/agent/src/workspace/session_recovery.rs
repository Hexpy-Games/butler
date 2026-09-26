//! Read-only recovery of the one session workspace reference.

mod authority;
mod git;
pub(in crate::workspace) mod path;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::{
    NativeCommands, NativeWorkspaceFiles, SessionBindingStore, WorkspaceReference, WorkspaceResult,
};
pub(crate) use authority::SessionWorkspaceAuthority;
use authority::resolve_authority;
pub(crate) use git::ProjectWorkspaceInspection;
use git::inspect_project_workspace;
use git::validate_linked_worktree;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionWorkspaceValidation {
    Valid { path: String, dirty: bool },
    Invalid { code: &'static str },
}

pub(crate) struct RecoveredSessionWorkspaceReference {
    pub authority: SessionWorkspaceAuthority,
    pub workspace_reference: WorkspaceReference,
    pub validation: SessionWorkspaceValidation,
}

#[derive(Clone)]
pub(crate) struct NativeSessionWorkspaceRecovery {
    bindings: SessionBindingStore,
    commands: NativeCommands,
    files: NativeWorkspaceFiles,
    host_environment: Arc<HashMap<String, String>>,
}

impl NativeSessionWorkspaceRecovery {
    pub(crate) fn new(
        bindings: SessionBindingStore,
        commands: NativeCommands,
        files: NativeWorkspaceFiles,
        host_environment: Arc<HashMap<String, String>>,
    ) -> Self {
        Self {
            bindings,
            commands,
            files,
            host_environment,
        }
    }

    pub(crate) async fn recover(
        &self,
        session_id: &str,
        project_workspace_path: Option<&str>,
        abort: CancellationToken,
    ) -> WorkspaceResult<RecoveredSessionWorkspaceReference> {
        let binding = self.bindings.get_by_session_id(session_id).await?;
        let authority = resolve_authority(binding.as_ref(), project_workspace_path);
        drop(binding);
        if let SessionWorkspaceAuthority::Unavailable { error_code, .. } = &authority {
            let error_code = *error_code;
            return Ok(RecoveredSessionWorkspaceReference {
                authority,
                workspace_reference: WorkspaceReference::unavailable(error_code),
                validation: SessionWorkspaceValidation::Invalid {
                    code: "session_workspace_unavailable",
                },
            });
        }
        let validation = match &authority {
            SessionWorkspaceAuthority::Project { workspace_path } => {
                if let Some(path) = workspace_path
                    .as_deref()
                    .filter(|path| !crate::public_text::trim_js_whitespace(path).is_empty())
                {
                    SessionWorkspaceValidation::Valid {
                        path: path.to_owned(),
                        dirty: false,
                    }
                } else {
                    SessionWorkspaceValidation::Invalid {
                        code: "session_workspace_unavailable",
                    }
                }
            }
            SessionWorkspaceAuthority::SessionWorktree { workspace_path, .. }
                if workspace_path.is_empty() =>
            {
                SessionWorkspaceValidation::Invalid {
                    code: "session_workspace_unavailable",
                }
            }
            SessionWorkspaceAuthority::SessionWorktree {
                workspace_path,
                marker,
                ..
            } => {
                validate_linked_worktree(
                    &self.commands,
                    &self.files,
                    &self.host_environment,
                    &marker.repository_anchor_path,
                    workspace_path,
                    &marker.branch,
                    abort,
                )
                .await?
            }
            // Returned above; kept total so the match needs no panic.
            SessionWorkspaceAuthority::Unavailable { .. } => SessionWorkspaceValidation::Invalid {
                code: "session_workspace_unavailable",
            },
        };
        let workspace_reference = match &validation {
            SessionWorkspaceValidation::Valid { path, .. } => {
                WorkspaceReference::new(std::path::Path::new(path))
            }
            SessionWorkspaceValidation::Invalid { code } => WorkspaceReference::unavailable(code),
        };
        Ok(RecoveredSessionWorkspaceReference {
            authority,
            workspace_reference,
            validation,
        })
    }

    pub(crate) async fn inspect_project(
        &self,
        workspace_path: &str,
        abort: CancellationToken,
    ) -> WorkspaceResult<ProjectWorkspaceInspection> {
        inspect_project_workspace(
            &self.commands,
            &self.files,
            &self.host_environment,
            workspace_path,
            abort,
        )
        .await
    }
}
