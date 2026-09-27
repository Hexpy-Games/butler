//! Failures of the App database lane (sessions, messages, projects, settings).

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of AppStorage failures.
    pub(crate) enum AppStorageCode {
        AcceptedMessageMissing = "accepted_message_missing",
        AcceptedTurnMissing = "accepted_turn_missing",
        AppEventJsonFailed = "app_event_json_failed",
        AppEventPayloadInvalid = "app_event_payload_invalid",
        AppJsonFailed = "app_json_failed",
        AppProjectLedgerIdentityInvalid = "app_project_ledger_identity_invalid",
        AppProjectLedgerPathResolutionFailed = "app_project_ledger_path_resolution_failed",
        AppProjectPreferencesInvalid = "app_project_preferences_invalid",
        AppProjectionJsonInvalid = "app_projection_json_invalid",
        AppProjectionMessageChanged = "app_projection_message_changed",
        AppProjectionMissing = "app_projection_missing",
        AppProjectionPayloadInvalid = "app_projection_payload_invalid",
        AppProjectionValueInvalid = "app_projection_value_invalid",
        AppSchemaJsonFailed = "app_schema_json_failed",
        AppSessionJsonInvalid = "app_session_json_invalid",
        AppSessionKindInvalid = "app_session_kind_invalid",
        AppSqliteCloseCompletionLost = "app_sqlite_close_completion_lost",
        AppSqliteError = "app_sqlite_error",
        AppSqliteInitializationChannelClosed = "app_sqlite_initialization_channel_closed",
        AppSqliteJoinFailed = "app_sqlite_join_failed",
        AppSqliteOperationCompletionLost = "app_sqlite_operation_completion_lost",
        AppSqliteOwnerClosed = "app_sqlite_owner_closed",
        AppSqliteParentCreateFailed = "app_sqlite_parent_create_failed",
        AppSqliteThreadPanicked = "app_sqlite_thread_panicked",
        AppSqliteThreadSpawnFailed = "app_sqlite_thread_spawn_failed",
        AppSqliteTransactionOpenAtClose = "app_sqlite_transaction_open_at_close",
        AppStagedOutboundIdentityConflict = "app_staged_outbound_identity_conflict",
        AppStagedOutboundMissing = "app_staged_outbound_missing",
        AppTranscriptIoFailed = "app_transcript_io_failed",
        AppTurnEventInvalid = "app_turn_event_invalid",
        AuthorityQueueImmutable = "authority_queue_immutable",
        AutomationIntervalInvalid = "automation_interval_invalid",
        AutomationJsonFailed = "automation_json_failed",
        AutomationNotEnabled = "automation_not_enabled",
        AutomationNotFound = "automation_not_found",
        AutomationStateInvalid = "automation_state_invalid",
        BranchJsonInvalid = "branch_json_invalid",
        BranchReservationLost = "branch_reservation_lost",
        EmptyQueuedMessage = "empty_queued_message",
        GeneralChannelProtected = "general_channel_protected",
        InvalidJson = "invalid_json",
        InvalidSessionControls = "invalid_session_controls",
        InvalidUtf8 = "invalid_utf8",
        MessageFileAlreadyAttached = "message_file_already_attached",
        MessageFileNotFound = "message_file_not_found",
        MessageFileWrongSession = "message_file_wrong_session",
        ModelNotConfigured = "model_not_configured",
        OperationOutputChunkConflict = "operation_output_chunk_conflict",
        OperationOutputChunkInvalid = "operation_output_chunk_invalid",
        OperationOutputInvalid = "operation_output_invalid",
        PlanNotAwaitingDecision = "plan_not_awaiting_decision",
        PlanProjectRequired = "plan_project_required",
        PreferencesChanged = "preferences_changed",
        ProjectCreationFailed = "project_creation_failed",
        ProjectLedgerIdentityMissing = "project_ledger_identity_missing",
        ProjectNotFound = "project_not_found",
        ProjectRequired = "project_required",
        ProjectSourceScopeChanged = "project_source_scope_changed",
        ProjectStatisticsLimit = "project_statistics_limit",
        ProjectWorkspaceAlreadyRegistered = "project_workspace_already_registered",
        ProjectWorkspaceUnavailable = "project_workspace_unavailable",
        ProjectedMessageMissing = "projected_message_missing",
        ProjectedTurnMissing = "projected_turn_missing",
        QueuedMessageChanged = "queued_message_changed",
        QueuedMessageClaimLost = "queued_message_claim_lost",
        QueuedMessageClaimMissing = "queued_message_claim_missing",
        QueuedMessageIdentityConflict = "queued_message_identity_conflict",
        QueuedMessageLinkIncomplete = "queued_message_link_incomplete",
        QueuedMessageNotFound = "queued_message_not_found",
        SessionModelUnavailable = "session_model_unavailable",
        SessionNotFound = "session_not_found",
        SessionRelocating = "session_relocating",
        SessionWorktreeCreationFailed = "session_worktree_creation_failed",
        SettingsJsonFailed = "settings_json_failed",
        SourceChanged = "source_changed",
        SourceUnavailable = "source_unavailable",
        TooManyAttachments = "too_many_attachments",
        TurnControlResolutionInvalid = "turn_control_resolution_invalid",
        TurnExecutionControlsMissing = "turn_execution_controls_missing",
        TurnMissingUserMessage = "turn_missing_user_message",
        TurnNotCancellable = "turn_not_cancellable",
        TurnNotFound = "turn_not_found",
        TurnNotRetryable = "turn_not_retryable",
        TurnRetryDispatchBusy = "turn_retry_dispatch_busy",
        TurnRetrySnapshotMissing = "turn_retry_snapshot_missing",
        UnknownChat = "unknown_chat",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type AppStorageSource = Arc<dyn Error + Send + Sync>;

/// Failures of the App database lane (sessions, messages, projects, settings).
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum AppStorageError {
    /// An App storage check failed: missing or conflicting row, invalid request
    /// or stored value, closed lane. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        code: AppStorageCode,
        message: String,
    },
    /// SQLite failed; the detail is SQLite's own text.
    #[error("app_sqlite_error: {source}")]
    Sqlite {
        #[source]
        source: Arc<rusqlite::Error>,
    },
    /// A lower-level operation (JSON, filesystem, thread, task join) failed;
    /// `code` names what App storage was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: AppStorageCode,
        message: String,
        #[source]
        source: AppStorageSource,
    },
}

impl AppStorageError {
    pub(crate) fn new(code: AppStorageCode, message: impl Into<String>) -> Self {
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
            Self::Sqlite { .. } => AppStorageCode::AppSqliteError.as_str(),
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
        }
    }

    /// The user-facing detail (the historical name of the message).
    pub(crate) fn detail(&self) -> String {
        self.message()
    }

    /// The user-facing message.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Detected { message, .. } | Self::Failed { message, .. } => message.clone(),
            Self::Sqlite { source } => source.to_string(),
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for AppStorageError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for AppStorageError {}

#[cfg(test)]
mod tests {
    use super::AppStorageCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = AppStorageCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
