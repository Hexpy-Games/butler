//! The gateway application error the HTTP layer renders.

use std::{future::Future, pin::Pin, sync::Arc};

/// An owned asynchronous application operation and its public gateway error.
pub type ApplicationFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, GatewayApplicationError>> + Send + 'static>>;

/// Whether the stored request can succeed on a later attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureClass {
    Permanent,
    Transient,
}

#[derive(Debug, thiserror::Error)]
#[error("permanent request failure")]
struct PermanentFailure(#[source] GatewayApplicationError);

#[derive(Debug, thiserror::Error)]
#[error("request committed before cleanup failed")]
struct CommittedFailure {
    #[source]
    error: GatewayApplicationError,
    sessions: Vec<String>,
}

/// A gateway application failure as the HTTP layer reports it.
#[derive(Clone, Debug, thiserror::Error)]
pub enum GatewayApplicationError {
    /// A failure shown to the client with this status, code and message;
    /// `source` keeps the underlying error (never shown to the client).
    #[error("{code}: {message}")]
    Public {
        status: u16,
        code: String,
        message: String,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// An unexpected failure; the client sees a generic 500. `source` keeps
    /// the underlying error when there is one (an unsupported default port
    /// operation has none).
    #[error("internal gateway error")]
    Internal {
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
}

impl GatewayApplicationError {
    /// Classifies invalid requests permanently; operational failures remain retryable.
    pub fn failure_class(&self) -> FailureClass {
        match self {
            Self::Public {
                status: 400 | 413 | 422,
                ..
            } => FailureClass::Permanent,
            Self::Public {
                source: Some(source),
                ..
            }
            | Self::Internal {
                source: Some(source),
            } if source.downcast_ref::<PermanentFailure>().is_some() => FailureClass::Permanent,
            _ => FailureClass::Transient,
        }
    }

    pub(crate) fn permanent(mut self) -> Self {
        let cause = Arc::new(PermanentFailure(self.clone()));
        match &mut self {
            Self::Public { source, .. } | Self::Internal { source } => *source = Some(cause),
        }
        self
    }

    /// Marks failures from work performed after a durable lifecycle commit.
    pub(crate) fn after_commit(self) -> Self {
        self.after_commit_with_sessions(Vec::new())
    }

    pub(crate) fn after_commit_with_sessions(mut self, sessions: Vec<String>) -> Self {
        let cause = Arc::new(CommittedFailure {
            error: self.clone(),
            sessions,
        });
        match &mut self {
            Self::Public { source, .. } | Self::Internal { source } => *source = Some(cause),
        }
        self
    }

    pub(crate) fn committed(&self) -> bool {
        let (Self::Public { source, .. } | Self::Internal { source }) = self;
        source
            .as_ref()
            .is_some_and(|cause| cause.is::<CommittedFailure>())
    }

    pub(crate) fn committed_sessions(&self) -> &[String] {
        let (Self::Public { source, .. } | Self::Internal { source }) = self;
        source
            .as_ref()
            .and_then(|cause| cause.downcast_ref::<CommittedFailure>())
            .map_or(&[], |cause| cause.sessions.as_slice())
    }

    /// A failure shown to the client.
    pub(crate) fn public(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Public {
            status,
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }

    /// An internal failure without an underlying error.
    pub fn internal() -> Self {
        Self::Internal { source: None }
    }

    /// Records `cause` as the source when none is recorded yet.
    #[must_use]
    pub fn with_source(mut self, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        let (Self::Public { source, .. } | Self::Internal { source }) = &mut self;
        if source.is_none() {
            *source = Some(Arc::new(cause));
        }
        self
    }

    /// An internal failure caused by `source`.
    pub fn internal_from(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Internal {
            source: Some(Arc::new(source)),
        }
    }
}

/// Wire equality: the same status, code and message; internal failures are
/// equal to each other (causes are diagnostic only).
impl PartialEq for GatewayApplicationError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Public {
                    status,
                    code,
                    message,
                    ..
                },
                Self::Public {
                    status: other_status,
                    code: other_code,
                    message: other_message,
                    ..
                },
            ) => status == other_status && code == other_code && message == other_message,
            (Self::Internal { .. }, Self::Internal { .. }) => true,
            _ => false,
        }
    }
}

impl Eq for GatewayApplicationError {}
