//! Failures of public web search and page retrieval.

use std::error::Error;
use std::sync::Arc;

wire_codes! {
    /// Wire codes of WebAccess failures.
    pub(crate) enum WebAccessCode {
        Cancelled = "cancelled",
        InvalidArguments = "invalid_arguments",
        WebAccessCacheFailed = "web_access_cache_failed",
        WebAccessConfigurationInvalid = "web_access_configuration_invalid",
        WebAccessReaderFailed = "web_access_reader_failed",
        WebAccessReaderTimeout = "web_access_reader_timeout",
        WebAccessReaderUnavailable = "web_access_reader_unavailable",
        WebAccessRequestFailed = "web_access_request_failed",
        WebAccessResponseFailed = "web_access_response_failed",
        WebAccessSpoolFailed = "web_access_spool_failed",
        WebAccessUnavailable = "web_access_unavailable",
        WebReadFailed = "web_read_failed",
        WebReadParseFailed = "web_read_parse_failed",
        WebSearchChallenge = "web_search_challenge",
        WebSearchParseFailed = "web_search_parse_failed",
        WebSearchPlannedAllFailed = "web_search_planned_all_failed",
        WebSearchPlannerFailed = "web_search_planner_failed",
        WebSearchProviderAuthMissing = "web_search_provider_auth_missing",
        WebSearchProviderDisabled = "web_search_provider_disabled",
        WebSearchProviderFailed = "web_search_provider_failed",
        WebSearchProviderModelMissing = "web_search_provider_model_missing",
        WebSearchRequestFailed = "web_search_request_failed",
        WebSearchResponseInvalid = "web_search_response_invalid",
    }
}

/// A shareable underlying error (errors are cloned to every waiter).
pub(crate) type WebAccessSource = Arc<dyn Error + Send + Sync>;

/// Failures of public web search and page retrieval.
///
/// `code()` is the persisted wire code, `message()` the user-facing text and
/// `Display` renders `code: message`.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum WebAccessError {
    /// A web access check failed: invalid query or URL, blocked or oversized
    /// page, missing configuration, cancelled retrieval. Nothing lower-level
    /// failed.
    #[error("{code}: {message}")]
    Detected {
        code: WebAccessCode,
        message: String,
    },
    /// A lower-level operation (HTTP, filesystem, JSON, model call) failed;
    /// `code` names what web access was doing and `source` is the cause.
    #[error("{code}: {message}")]
    Failed {
        code: WebAccessCode,
        message: String,
        #[source]
        source: WebAccessSource,
    },
}

impl WebAccessError {
    pub(crate) fn new(code: WebAccessCode, message: impl Into<String>) -> Self {
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

    pub(crate) fn cancelled() -> Self {
        Self::new(
            WebAccessCode::Cancelled,
            "Public web retrieval was cancelled.",
        )
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

/// Wire equality: the same code and message (causes are diagnostic only).
impl PartialEq for WebAccessError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code() && self.message() == other.message()
    }
}

impl Eq for WebAccessError {}

#[cfg(test)]
mod tests {
    use super::WebAccessCode;

    #[test]
    fn wire_codes_are_stable() {
        let codes: Vec<&str> = WebAccessCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        let expected: Vec<&str> = include_str!("wire_codes.txt").lines().collect();
        assert_eq!(codes, expected);
    }
}
