//! Failures of guided and structured command execution.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Command failures.
    pub(crate) enum CommandCode {
        CommandCancelled = "command_cancelled",
        CommandCaptureFailed = "command_capture_failed",
        CommandCwdFailed = "command_cwd_failed",
        CommandCwdRejected = "command_cwd_rejected",
        CommandEnvironmentFailed = "command_environment_failed",
        CommandInvalid = "command_invalid",
        CommandIoFailed = "command_io_failed",
        CommandJsonFailed = "command_json_failed",
        CommandOutputOverflow = "command_output_overflow",
        CommandOwnerClosed = "command_owner_closed",
        CommandOwnerExhausted = "command_owner_exhausted",
        CommandPlanEmpty = "command_plan_empty",
        CommandSettlementLost = "command_settlement_lost",
        CommandSpawnFailed = "command_spawn_failed",
        CommandStreamFailed = "command_stream_failed",
        CommandTerminationFailed = "command_termination_failed",
        CommandWaitFailed = "command_wait_failed",
        LegacyCommandEmpty = "legacy_command_empty",
        LegacyShellSpawnFailed = "legacy_shell_spawn_failed",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type CommandSource = Arc<dyn Error + Send + Sync>;

/// Failures of guided and structured command execution.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum CommandError {
    /// The workspace path guard rejected the command directory; `reason` is
    /// the guard's wire code.
    #[error(
        "{reason}: The requested command directory is outside the admitted workspace safety policy."
    )]
    CwdRejected { reason: &'static str },
    /// A command check failed (empty command, cwd outside the workspace, timeout,
    /// capture limit, cancelled lane). Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected { code: CommandCode, message: String },
    /// A filesystem or process I/O call failed outright; the message is its text.
    #[error("command_io_failed: {source}")]
    Io {
        #[source]
        source: Arc<std::io::Error>,
    },
    /// A process, pipe or environment operation failed; `code` names what the
    /// command runner was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: CommandCode,
        message: String,
        #[source]
        source: CommandSource,
    },
}

impl CommandError {
    pub(crate) fn new(code: CommandCode, message: impl Into<String>) -> Self {
        Self::Detected {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn io(error: std::io::Error) -> Self {
        Self::Io {
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
            Self::Io { .. } => CommandCode::CommandIoFailed.as_str(),
            Self::Detected { code, .. } | Self::Failed { code, .. } => code.as_str(),
            Self::CwdRejected { reason } => reason,
        }
    }

    /// The user-facing message.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Detected { message, .. } | Self::Failed { message, .. } => message.clone(),
            Self::Io { source } => source.to_string(),
            Self::CwdRejected { .. } => {
                "The requested command directory is outside the admitted workspace safety policy."
                    .to_owned()
            }
        }
    }
}

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for CommandError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for CommandError {}

impl CommandError {
    /// The I/O error kind when the cause is an I/O error (e.g. a spawn failure).
    pub(crate) fn io_kind(&self) -> Option<std::io::ErrorKind> {
        match self {
            Self::Io { source } => Some(source.kind()),
            Self::Failed { source, .. } => source
                .downcast_ref::<std::io::Error>()
                .map(std::io::Error::kind),
            Self::Detected { .. } | Self::CwdRejected { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CommandCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = CommandCode::ALL.iter().map(|code| code.as_str()).collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
