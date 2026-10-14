//! The gateway application error the HTTP layer renders.

use std::{future::Future, pin::Pin, sync::Arc};

/// An owned asynchronous application operation and its public gateway error.
pub type ApplicationFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, GatewayApplicationError>> + Send + 'static>>;

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
