//! Failures of the durable inbound message queue.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of inbound queue failures.
    pub(crate) enum InboundQueueCode {
        InboundEnvelopeInvalid = "inbound_envelope_invalid",
        InboundQueueEncodeFailed = "inbound_queue_encode_failed",
        InboundQueueIoFailed = "inbound_queue_io_failed",
        InboundQueuePathInvalid = "inbound_queue_path_invalid",
        InboundQueueTimeInvalid = "inbound_queue_time_invalid",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type QueueSource = Arc<dyn Error + Send + Sync>;

/// Failures of the durable inbound message queue.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum InboundQueueError {
    /// A queue check failed: invalid or conflicting record, missing claim,
    /// closed lane. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        code: InboundQueueCode,
        message: String,
    },
    /// A filesystem, JSON or task operation failed; `code` names what the queue
    /// was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: InboundQueueCode,
        message: String,
        #[source]
        source: QueueSource,
    },
}

impl InboundQueueError {
    pub(crate) fn new(code: InboundQueueCode, message: impl Into<String>) -> Self {
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

    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
        }
    }

    /// The user-facing message.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Detected { message, .. } | Self::Failed { message, .. } => message.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::InboundQueueCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = InboundQueueCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
