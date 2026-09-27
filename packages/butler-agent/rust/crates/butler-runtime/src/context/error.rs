//! Failures of prompt, conversation-tool and tool-output context assembly.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Context failures.
    pub enum ContextCode {
        ArtifactNotFound = "artifact_not_found",
        ArtifactReferenceRequired = "artifact_reference_required",
        ArtifactScanLimitExceeded = "artifact_scan_limit_exceeded",
        AttachmentCompletionLost = "attachment_completion_lost",
        AttachmentJoinFailed = "attachment_join_failed",
        Closed = "closed",
        ContextCompactionLockError = "context_compaction_lock_error",
        ContextCompactionLockTimeout = "context_compaction_lock_timeout",
        ContextCompactionPathInvalid = "context_compaction_path_invalid",
        ContextCompactionSnapshotError = "context_compaction_snapshot_error",
        ContextConversationError = "context_conversation_error",
        ContextConversationReadError = "context_conversation_read_error",
        ContextGroupEmpty = "context_group_empty",
        ContextJsonError = "context_json_error",
        ContextMetricWriteError = "context_metric_write_error",
        ContextModelMetadataError = "context_model_metadata_error",
        ContextNumberInvalid = "context_number_invalid",
        ContextTokenEstimateError = "context_token_estimate_error",
        ConversationContextCompletionLost = "conversation_context_completion_lost",
        ConversationContextSerializeFailed = "conversation_context_serialize_failed",
        ConversationListCompletionLost = "conversation_list_completion_lost",
        ConversationListJoinFailed = "conversation_list_join_failed",
        ConversationStoreUnavailable = "conversation_store_unavailable",
        DateTimezoneUnavailable = "date_timezone_unavailable",
        ImageManifestInvalid = "image_manifest_invalid",
        ImagePayloadInvalid = "image_payload_invalid",
        InvalidArguments = "invalid_arguments",
        InvalidArray = "invalid_array",
        InvalidCursor = "invalid_cursor",
        InvalidInteger = "invalid_integer",
        InvalidProjectFilter = "invalid_project_filter",
        InvalidScope = "invalid_scope",
        InvalidScopeValue = "invalid_scope_value",
        InvalidSessionKind = "invalid_session_kind",
        InvalidTime = "invalid_time",
        Json = "json",
        PromptAssemblyCancelled = "prompt_assembly_cancelled",
        PromptFileReadError = "prompt_file_read_error",
        PromptJsonError = "prompt_json_error",
        PromptTimeFormatError = "prompt_time_format_error",
        ReferenceCompletionLost = "reference_completion_lost",
        ReferenceJoinFailed = "reference_join_failed",
        SourceChanged = "source_changed",
        SourceNotFound = "source_not_found",
        SourceSnapshotChanged = "source_snapshot_changed",
        SourceUnavailable = "source_unavailable",
        StaleCursor = "stale_cursor",
        ToolEvidenceJsonError = "tool_evidence_json_error",
        ToolOutputClosed = "tool_output_closed",
        ToolOutputCompletionLost = "tool_output_completion_lost",
        ToolOutputIoError = "tool_output_io_error",
        ToolOutputJsonError = "tool_output_json_error",
        ToolOutputPathEncoding = "tool_output_path_encoding",
        ToolOutputWorkerFailed = "tool_output_worker_failed",
        UnsafeArtifactPath = "unsafe_artifact_path",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type ContextSource = Arc<dyn Error + Send + Sync>;

/// Failures of prompt, conversation-tool and tool-output context assembly.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum ContextError {
    /// A context check failed: invalid scope or cursor, missing record, budget or
    /// artifact limit, closed owner. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected { code: ContextCode, message: String },
    /// A port implemented outside Context (Cognition prompt memory, Profile,
    /// host stores) failed; `code` and `message` are that implementation's own.
    #[error("{code}: {message}")]
    Port {
        code: &'static str,
        message: String,
        #[source]
        source: Option<ContextSource>,
    },
    /// A lower-level operation (filesystem, JSON, SQLite, task join) failed;
    /// `code` names what context assembly was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: ContextCode,
        message: String,
        #[source]
        source: ContextSource,
    },
}

impl ContextError {
    pub fn new(code: ContextCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
        }
    }

    /// Surfaces a port implementation's failure with its own code and message.
    pub fn port(
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

    /// A port implementation's failure that has no underlying error.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn relayed(code: &'static str, message: impl Into<String>) -> Self {
        Self::Port {
            code,
            message: message.into(),
            source: None,
        }
    }

    /// Records `source` as the cause of a detected failure, keeping its code
    /// and message. An error that already carries a cause is returned as is.
    #[must_use]
    pub fn with_source(self, source: impl Error + Send + Sync + 'static) -> Self {
        match self {
            Self::Detected { code, message } => Self::Failed {
                code,
                message,
                source: Arc::new(source),
            },
            other => other,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
            Self::Port { code, .. } => code,
        }
    }

    /// The user-facing message.
    pub fn message(&self) -> String {
        match self {
            Self::Detected { message, .. }
            | Self::Failed { message, .. }
            | Self::Port { message, .. } => message.clone(),
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for ContextError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for ContextError {}

impl From<ContextError> for butler_turn::btcc::BtccError {
    fn from(error: ContextError) -> Self {
        Self::relay(error.code(), error.message(), error)
    }
}

#[cfg(test)]
mod tests {
    use super::ContextCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = ContextCode::ALL.iter().map(|code| code.as_str()).collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
