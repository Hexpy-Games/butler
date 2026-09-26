//! Conversation store failures.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Conversation failures that are not tied to one source type.
    pub(crate) enum ConversationCode {
        ConversationCloseCompletionLost = "conversation_close_completion_lost",
        ConversationClosed = "conversation_closed",
        ConversationCompletionLost = "conversation_completion_lost",
        ConversationInitializationLost = "conversation_initialization_lost",
        ConversationJoinFailed = "conversation_join_failed",
        ConversationJsonError = "conversation_json_error",
        ConversationMessageMissing = "conversation_message_missing",
        ConversationMessageNotFound = "conversation_message_not_found",
        ConversationObserverClosed = "conversation_observer_closed",
        ConversationObserverJoinFailed = "conversation_observer_join_failed",
        ConversationOriginInvalid = "conversation_origin_invalid",
        ConversationOutcomeGenerationConflict = "conversation_outcome_generation_conflict",
        ConversationOutcomeSessionMismatch = "conversation_outcome_session_mismatch",
        ConversationParentCreateFailed = "conversation_parent_create_failed",
        ConversationProvenanceInvalid = "conversation_provenance_invalid",
        ConversationRecoveryInputUnavailable = "conversation_recovery_input_unavailable",
        ConversationRoleInvalid = "conversation_role_invalid",
        ConversationSessionNotFound = "conversation_session_not_found",
        ConversationSourceChanged = "conversation_source_changed",
        ConversationSourceClosed = "conversation_source_closed",
        ConversationSourceRefConflict = "conversation_source_ref_conflict",
        ConversationSourceRefRoleUnsupported = "conversation_source_ref_role_unsupported",
        ConversationSourceSchemaUnavailable = "conversation_source_schema_unavailable",
        ConversationSourceUnavailable = "conversation_source_unavailable",
        ConversationSqliteError = "conversation_sqlite_error",
        ConversationStaleSummaryRequiresWriter = "conversation_stale_summary_requires_writer",
        ConversationTableInvalid = "conversation_table_invalid",
        ConversationThreadMissing = "conversation_thread_missing",
        ConversationThreadPanicked = "conversation_thread_panicked",
        ConversationThreadSpawnFailed = "conversation_thread_spawn_failed",
        ConversationTransactionOpenAtClose = "conversation_transaction_open_at_close",
        ConversationTurnNotFound = "conversation_turn_not_found",
        ConversationValueInvalid = "conversation_value_invalid",
        InvalidScope = "invalid_scope",
        MemoryOriginClassificationConflict = "memory_origin_classification_conflict",
        MemoryOriginEvidenceUnavailable = "memory_origin_evidence_unavailable",
        MemoryOriginOutboxIdentityInvalid = "memory_origin_outbox_identity_invalid",
        MemorySourceChanged = "memory_source_changed",
    }
}

/// A shareable underlying error (store results are cloned to every close waiter).
pub(crate) type ConversationSource = Arc<dyn Error + Send + Sync>;

/// A Conversation store failure.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum ConversationError {
    /// A Conversation check failed: missing row, invalid stored value, conflict
    /// or a closed execution lane. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        code: ConversationCode,
        message: String,
    },
    /// SQLite failed; the message is SQLite's own text.
    #[error("conversation_sqlite_error: {source}")]
    Sqlite {
        #[source]
        source: Arc<rusqlite::Error>,
    },
    /// Encoding or decoding a stored JSON value failed.
    #[error("conversation_json_error: {source}")]
    Json {
        #[source]
        source: ConversationSource,
    },
    /// A port implemented outside this domain failed (for example the
    /// completion publisher behind the admission observer); `code` and
    /// `message` are that implementation's own.
    #[error("{code}: {message}")]
    Port {
        code: &'static str,
        message: String,
        #[source]
        source: ConversationSource,
    },
    /// A lower-level operation (thread, task join, channel, filesystem) failed;
    /// `code` names what the store was doing.
    #[error("{code}: {message}")]
    Failed {
        code: ConversationCode,
        message: String,
        #[source]
        source: ConversationSource,
    },
}

impl ConversationError {
    pub(crate) fn new(code: ConversationCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
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
            source: Arc::new(source),
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
            Self::Sqlite { .. } => ConversationCode::ConversationSqliteError.as_str(),
            Self::Json { .. } => ConversationCode::ConversationJsonError.as_str(),
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
            Self::Port { code, .. } => code,
        }
    }

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

#[cfg(test)]
mod tests {
    use super::ConversationCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = ConversationCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
