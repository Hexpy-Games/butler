//! Failures generating the new-chat briefing.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of BriefingGeneration failures.
    pub enum BriefingGenerationCode {
        MemorySourceChanged = "memory_source_changed",
        MemoryWriteBusy = "memory_write_busy",
        NewChatBriefingAppReadFailed = "new_chat_briefing_app_read_failed",
        NewChatBriefingCancelled = "new_chat_briefing_cancelled",
        NewChatBriefingInvalidModelOutput = "new_chat_briefing_invalid_model_output",
        NewChatBriefingLedgerFailed = "new_chat_briefing_ledger_failed",
        NewChatBriefingModelFailed = "new_chat_briefing_model_failed",
        NewChatBriefingProfileFailed = "new_chat_briefing_profile_failed",
        NewChatBriefingSettingsFailed = "new_chat_briefing_settings_failed",
        NewChatBriefingTimeFailed = "new_chat_briefing_time_failed",
        NewChatBriefingWriteFailed = "new_chat_briefing_write_failed",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type BriefingGenerationSource = Arc<dyn Error + Send + Sync>;

/// Failures generating the new-chat briefing.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum BriefingGenerationError {
    /// A briefing check failed: invalid model output, missing inputs, busy writer.
    /// Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        /// What failed.
        code: BriefingGenerationCode,
        /// Details.
        message: String,
    },
    /// A lower-level operation (model call, filesystem, JSON, clock) failed;
    /// `code` names the briefing step and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        /// What the briefing was doing.
        code: BriefingGenerationCode,
        /// Details.
        message: String,
        /// The cause.
        #[source]
        source: BriefingGenerationSource,
    },
}

impl BriefingGenerationError {
    /// A detected failure.
    pub fn new(code: BriefingGenerationCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
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
            failed @ Self::Failed { .. } => failed,
        }
    }

    /// The stable code of the failure.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
        }
    }

    /// The user-facing message.
    pub fn message(&self) -> String {
        match self {
            Self::Detected { message, .. } | Self::Failed { message, .. } => message.clone(),
        }
    }
}
