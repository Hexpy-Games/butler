//! Failures of the scheduled-automation owner.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Automation failures.
    pub enum AutomationCode {
        AutomationDateInvalid = "automation_date_invalid",
        AutomationEnvelopeInvalid = "automation_envelope_invalid",
        AutomationInvalid = "automation_invalid",
        AutomationPreviewInvalid = "automation_preview_invalid",
        AutomationServiceClosed = "automation_service_closed",
        AutomationStoreUnavailable = "automation_store_unavailable",
        AutomationToolUnknown = "automation_tool_unknown",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type AutomationSource = Arc<dyn Error + Send + Sync>;

/// Failures of the scheduled-automation owner.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum AutomationError {
    /// An automation check failed: invalid schedule or definition, missing
    /// automation, closed owner. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        code: AutomationCode,
        message: String,
    },
    /// The automation queue behind the port failed; `code` and `message` are
    /// that implementation's own.
    #[error("{code}: {message}")]
    Port {
        code: &'static str,
        message: String,
        #[source]
        source: Option<AutomationSource>,
    },
    /// A lower-level operation (filesystem, JSON, task join, channel) failed;
    /// `code` names what the automation owner was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: AutomationCode,
        message: String,
        #[source]
        source: AutomationSource,
    },
}

impl AutomationError {
    pub fn new(code: AutomationCode, message: impl Into<String>) -> Self {
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
