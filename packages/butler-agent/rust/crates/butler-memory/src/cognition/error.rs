//! Failures of Cognition memory: registration, graph, generations, hot cache,

use std::error::Error;
use std::sync::Arc;

mod codes;

pub use codes::CognitionCode;

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type CognitionSource = Arc<dyn Error + Send + Sync>;

/// Failures of Cognition memory: registration, graph, generations, hot cache,
/// feedback, know-how, capsules and recovery.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum CognitionError {
    /// A Cognition check failed: invalid input or stored record, changed source,
    /// busy or aborted writer, closed owner. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        /// What failed.
        code: CognitionCode,
        /// Details.
        message: String,
    },
    /// A port or domain Cognition depends on failed (Conversation, the write
    /// gate, the model provider, host embedding workers); `code` and `message`
    /// are that implementation's own.
    #[error("{code}: {message}")]
    Port {
        /// The port's code.
        code: &'static str,
        /// The port's message.
        message: String,
        /// The port's error, when it has one.
        #[source]
        source: Option<CognitionSource>,
    },
    /// A lower-level operation (filesystem, SQLite, LanceDB, JSON, embedding,
    /// task join) failed; `code` names what Cognition was doing and `source` is
    /// the cause.
    #[error("{code}: {message}")]
    Failed {
        /// What Cognition was doing.
        code: CognitionCode,
        /// Details.
        message: String,
        /// The cause.
        #[source]
        source: CognitionSource,
    },
}

impl CognitionError {
    /// A detected failure.
    pub fn new(code: CognitionCode, message: impl Into<String>) -> Self {
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
            source: Some(Arc::new(source)),
        }
    }

    /// A port implementation's failure that has no underlying error.
    #[cfg(test)]
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

    /// Replaces the message, keeping the code; the original error becomes the
    /// source (used when a retry loop gives up on a failure it already saw).
    #[must_use]
    pub(crate) fn with_message(self, message: impl Into<String>) -> Self {
        match self {
            Self::Port { code, .. } => Self::Port {
                code,
                message: message.into(),
                source: Some(Arc::new(self)),
            },
            Self::Detected { code, .. } | Self::Failed { code, .. } => Self::Failed {
                code,
                message: message.into(),
                source: Arc::new(self),
            },
        }
    }

    /// The stable code of the failure.
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
impl PartialEq for CognitionError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for CognitionError {}

/// Result of a Cognition operation.
pub type CognitionResult<T> = Result<T, CognitionError>;

impl From<crate::coordination::CoordinationError> for CognitionError {
    fn from(error: crate::coordination::CoordinationError) -> Self {
        Self::port(error.code(), error.message(), error)
    }
}

impl From<butler_turn::conversation::ConversationError> for CognitionError {
    fn from(error: butler_turn::conversation::ConversationError) -> Self {
        Self::port(error.code(), error.message(), error)
    }
}

#[cfg(test)]
mod tests {
    use super::CognitionCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = CognitionCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
