//! The error every CLI command reports: a wire code, a user-facing message,
//! the process exit code, and the underlying error (never printed).

use std::borrow::Cow;
use std::error::Error;

/// A failed CLI command.
///
/// `code` and `message` are printed (JSON `error` object or `code: message`),
/// `exit` is the process exit code, and `source` keeps the cause for logs and
/// debugging.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub(crate) struct CliError {
    pub(crate) code: Cow<'static, str>,
    pub(crate) message: String,
    pub(crate) exit: u8,
    #[source]
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl CliError {
    /// Rejected arguments (`invalid_arguments`, exit 2).
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_arguments", message, 2)
    }

    /// A failed operation with its own code (exit 1).
    pub(crate) fn failed(code: impl Into<Cow<'static, str>>, message: impl Into<String>) -> Self {
        Self::new(code, message, 1)
    }

    /// A failed health check (`health_failed`, exit 3).
    pub(crate) fn health(message: impl Into<String>) -> Self {
        Self::new("health_failed", message, 3)
    }

    fn new(code: impl Into<Cow<'static, str>>, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            exit,
            source: None,
        }
    }

    /// Uses `exit` as the process exit code.
    #[must_use]
    pub(crate) fn with_exit(mut self, exit: u8) -> Self {
        self.exit = exit;
        self
    }

    /// Records the underlying error.
    #[must_use]
    pub(crate) fn with_source(mut self, source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        self.source = Some(source.into());
        self
    }
}
