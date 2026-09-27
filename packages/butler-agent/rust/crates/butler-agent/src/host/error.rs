//! The error of the process edge: installation, service startup and the CLI
//! helpers whose failures are shown to the user as one line of text.

use std::borrow::Cow;
use std::error::Error;

/// A process-edge failure. `Display` is the user-facing text (unchanged from
/// the `String` errors this replaces); `source` keeps the underlying error.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct HostError {
    message: Cow<'static, str>,
    #[source]
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl HostError {
    /// A failure described by `message`, with no underlying error.
    pub(crate) fn new(message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            message: message.into(),
            source: None,
        }
    }

    /// An underlying error reported with its own text.
    pub(crate) fn from_error(source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        let source = source.into();
        Self {
            message: source.to_string().into(),
            source: Some(source),
        }
    }

    /// Records the underlying error, keeping the message.
    #[must_use]
    pub(crate) fn with_source(mut self, source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        self.source = Some(source.into());
        self
    }

    /// The user-facing text.
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl From<String> for HostError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<&'static str> for HostError {
    fn from(message: &'static str) -> Self {
        Self::new(message)
    }
}

/// Compares the user-facing text (tests and callers that match on messages).
impl PartialEq<&str> for HostError {
    fn eq(&self, other: &&str) -> bool {
        self.message == *other
    }
}
