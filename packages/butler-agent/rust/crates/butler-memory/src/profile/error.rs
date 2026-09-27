//! Failures of the personalization profile (extraction, imports, storage).

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of Profile failures.
    pub enum ProfileCode {
        MemoryWriteBusy = "memory_write_busy",
        PersonalizationWriteFailed = "personalization_write_failed",
        ProfileClosed = "profile_closed",
        ProfileCommitInterrupted = "profile_commit_interrupted",
        ProfileDataInvalid = "profile_data_invalid",
        ProfileExtractorInvalid = "profile_extractor_invalid",
        ProfileModelFailed = "profile_model_failed",
        ProfileOperationFailed = "profile_operation_failed",
        ProfileResultInvalid = "profile_result_invalid",
        ProfileStoreUnavailable = "profile_store_unavailable",
        ProfileWriteFailed = "profile_write_failed",
        UnknownTool = "unknown_tool",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type ProfileSource = Arc<dyn Error + Send + Sync>;

/// Failures of the personalization profile (extraction, imports, storage).
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub enum ProfileError {
    /// A profile check failed: invalid input or stored record, missing profile,
    /// busy or closed owner. Nothing lower-level failed.
    #[error("{code}: {message}")]
    Detected {
        /// What failed.
        code: ProfileCode,
        /// Details.
        message: String,
    },
    /// A port implemented outside Profile (Conversation sources, the model
    /// provider, the write gate) failed; `code` and `message` are that
    /// implementation's own.
    #[error("{code}: {message}")]
    Port {
        /// The port's code.
        code: &'static str,
        /// The port's message.
        message: String,
        /// The port's error, when it has one.
        #[source]
        source: Option<ProfileSource>,
    },
    /// A lower-level operation (filesystem, JSON, model call, task join) failed;
    /// `code` names what the profile owner was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        /// What the profile was doing.
        code: ProfileCode,
        /// Details.
        message: String,
        /// The cause.
        #[source]
        source: ProfileSource,
    },
}

impl ProfileError {
    /// A detected failure.
    pub fn new(code: ProfileCode, message: impl Into<String>) -> Self {
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
impl PartialEq for ProfileError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for ProfileError {}

#[cfg(test)]
mod tests {
    use super::ProfileCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = ProfileCode::ALL.iter().map(|code| code.as_str()).collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
