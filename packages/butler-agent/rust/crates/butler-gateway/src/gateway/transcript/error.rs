//! Failures of the session transcript writer.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Transcript failures.
    pub enum TranscriptCode {
        TranscriptActionInvalid = "transcript_action_invalid",
        TranscriptAppendFailed = "transcript_append_failed",
        TranscriptDeliveryInvalid = "transcript_delivery_invalid",
        TranscriptEventJsonInvalid = "transcript_event_json_invalid",
        TranscriptJoinFailed = "transcript_join_failed",
        TranscriptWriterClosed = "transcript_writer_closed",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type TranscriptSource = Arc<dyn Error + Send + Sync>;

/// Failures of the session transcript writer.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum TranscriptError {
    /// A transcript check failed: invalid event, closed writer. Nothing
    /// lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        code: TranscriptCode,
        message: String,
    },
    /// A filesystem or JSON operation failed; `code` names what the writer was
    /// doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: TranscriptCode,
        message: String,
        #[source]
        source: TranscriptSource,
    },
}

impl TranscriptError {
    pub(crate) fn new(code: TranscriptCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
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
            failed @ Self::Failed { .. } => failed,
        }
    }

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

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for TranscriptError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for TranscriptError {}

#[cfg(test)]
mod tests {
    use super::TranscriptCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = TranscriptCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
