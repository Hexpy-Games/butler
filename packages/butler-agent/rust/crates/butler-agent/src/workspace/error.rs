//! Failures of the workspace session-binding store and workspace resolution.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Workspace failures.
    pub(crate) enum WorkspaceCode {
        Cancelled = "cancelled",
        GitNotInstalled = "git_not_installed",
        GitOperationFailed = "git_operation_failed",
        GitRepositoryRequired = "git_repository_required",
        GitWorkspaceUnavailable = "git_workspace_unavailable",
        InvalidBranch = "invalid_branch",
        LinkedWorktreeNotFound = "linked_worktree_not_found",
        PartialCreation = "partial_creation",
        RelocationPlanInvalid = "relocation_plan_invalid",
        SessionStoreCloseFailed = "session_store_close_failed",
        SessionStoreSchemaUnavailable = "session_store_schema_unavailable",
        SessionStoreUnavailable = "session_store_unavailable",
        SessionWorkspaceUnavailable = "session_workspace_unavailable",
        SessionWorktreeCommandLost = "session_worktree_command_lost",
        SessionWorktreeIo = "session_worktree_io",
        SessionWorktreeOwnerClosed = "session_worktree_owner_closed",
        SessionWorktreeOwnerLost = "session_worktree_owner_lost",
        WorkspaceCasLost = "workspace_cas_lost",
        WorkspaceCloseCompletionLost = "workspace_close_completion_lost",
        WorkspaceClosed = "workspace_closed",
        WorkspaceCompletionLost = "workspace_completion_lost",
        WorkspaceInitializationLost = "workspace_initialization_lost",
        WorkspaceInvalidTime = "workspace_invalid_time",
        WorkspaceJoinFailed = "workspace_join_failed",
        WorkspaceJsonError = "workspace_json_error",
        WorkspaceParentCreateFailed = "workspace_parent_create_failed",
        WorkspaceRecoveryCommandLost = "workspace_recovery_command_lost",
        WorkspaceRecoveryIo = "workspace_recovery_io",
        WorkspaceReferenceFailed = "workspace_reference_failed",
        WorkspaceSqliteError = "workspace_sqlite_error",
        WorkspaceThreadMissing = "workspace_thread_missing",
        WorkspaceThreadPanicked = "workspace_thread_panicked",
        WorkspaceThreadSpawnFailed = "workspace_thread_spawn_failed",
        WorkspaceTransactionOpenAtClose = "workspace_transaction_open_at_close",
        WorkspaceUpsertLost = "workspace_upsert_lost",
        WorktreeCleanupFailed = "worktree_cleanup_failed",
        WorktreePreparationFailed = "worktree_preparation_failed",
        WorktreeTargetOccupied = "worktree_target_occupied",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type WorkspaceSource = Arc<dyn Error + Send + Sync>;

/// Failures of the workspace session-binding store and workspace resolution.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum WorkspaceError {
    /// A workspace check failed (missing binding, invalid path, conflict, closed
    /// store). Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        code: WorkspaceCode,
        message: String,
    },
    /// SQLite failed; the message is SQLite's own text.
    #[error("workspace_sqlite_error: {source}")]
    Sqlite {
        #[source]
        source: Arc<rusqlite::Error>,
    },
    /// Encoding or decoding a stored JSON value failed.
    #[error("workspace_json_error: {source}")]
    Json {
        #[source]
        source: WorkspaceSource,
    },
    /// Another component failed: the command runner, the file owner, or a port
    /// implemented outside this domain. `code` and `message` are its own.
    #[error("{code}: {message}")]
    Port {
        code: &'static str,
        message: String,
        #[source]
        source: Option<WorkspaceSource>,
    },
    /// A lower-level operation (filesystem, thread, task join) failed; `code`
    /// names what the store was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: WorkspaceCode,
        message: String,
        #[source]
        source: WorkspaceSource,
    },
}

impl WorkspaceError {
    pub(crate) fn new(code: WorkspaceCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn sqlite(error: rusqlite::Error) -> Self {
        Self::Sqlite {
            source: Arc::new(error),
        }
    }

    pub(crate) fn json(error: impl Error + Send + Sync + 'static) -> Self {
        Self::Json {
            source: Arc::new(error),
        }
    }

    /// Surfaces a port implementation's failure with its own code and message.
    pub(crate) fn port(
        code: &'static str,
        message: impl Into<String>,
        source: impl Error + Send + Sync + 'static,
    ) -> Self {
        Self::Port {
            code,
            message: message.into(),
            source: Some(Arc::new(source)),
        }
    }

    /// Records `source` as the cause of a detected failure, keeping its code
    /// and message. An error that already carries a cause is returned as is.
    #[must_use]
    pub(crate) fn with_source(self, source: impl Error + Send + Sync + 'static) -> Self {
        match self {
            Self::Detected { code, message } => Self::Failed {
                code,
                message,
                source: Arc::new(source),
            },
            other => other,
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Sqlite { .. } => WorkspaceCode::WorkspaceSqliteError.as_str(),
            Self::Json { .. } => WorkspaceCode::WorkspaceJsonError.as_str(),
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
            Self::Port { code, .. } => code,
        }
    }

    /// The user-facing message.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Detected { message, .. }
            | Self::Failed { message, .. }
            | Self::Port { message, .. } => message.clone(),
            Self::Sqlite { source } => source.to_string(),
            Self::Json { source } => source.to_string(),
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for WorkspaceError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for WorkspaceError {}

impl From<super::CommandError> for WorkspaceError {
    fn from(error: super::CommandError) -> Self {
        Self::port(error.code(), error.message(), error)
    }
}

impl From<super::FileOwnerError> for WorkspaceError {
    fn from(error: super::FileOwnerError) -> Self {
        Self::port(error.code(), "Workspace file owner closed", error)
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = WorkspaceCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
