//! Access the active App gateway from its own process.
use axum::{body::to_bytes, response::Response};
use butler_gateway::gateway::{ADMIN_CREDENTIAL_HEADER, InProcessError};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde_json::Value;
use tokio::time::{Instant, timeout_at};

use crate::host::ActiveAppEndpoint;

pub(crate) struct SelfApi<'a>(&'a ActiveAppEndpoint);

#[derive(Debug, thiserror::Error)]
pub(crate) enum SelfApiError {
    #[error("gateway unavailable")]
    Unavailable,
    #[error("gateway request outcome unknown")]
    Unknown,
}

pub(crate) struct SelfResponse {
    response: Response,
    deadline: Option<Instant>,
}

#[derive(Debug, thiserror::Error)]
#[error("gateway response body could not be read")]
pub(crate) struct SelfBodyError;

impl<'a> SelfApi<'a> {
    pub(crate) fn new(endpoint: &'a ActiveAppEndpoint) -> Self {
        Self(endpoint)
    }

    pub(crate) async fn request(
        &self,
        method: Method,
        path_and_query: &str,
        body: Option<&Value>,
        admin: Option<&str>,
        deadline: Option<Instant>,
    ) -> Result<SelfResponse, SelfApiError> {
        let snapshot = self.0.snapshot().ok_or(SelfApiError::Unavailable)?;
        let gateway = snapshot.in_process.ok_or(SelfApiError::Unavailable)?;
        let mut headers = HeaderMap::new();
        if let Some(token) = snapshot.local_auth.token() {
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| SelfApiError::Unknown)?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        if let Some(admin) = admin {
            let mut value = HeaderValue::from_str(admin).map_err(|_| SelfApiError::Unknown)?;
            value.set_sensitive(true);
            headers.insert(ADMIN_CREDENTIAL_HEADER, value);
        }
        let body = if let Some(body) = body {
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            Bytes::from(serde_json::to_vec(body).map_err(|_| SelfApiError::Unknown)?)
        } else {
            Bytes::new()
        };
        let request = gateway.request(method, path_and_query, headers, body);
        let response = match deadline {
            Some(deadline) => timeout_at(deadline, request)
                .await
                .map_err(|_| SelfApiError::Unknown)?,
            None => request.await,
        }
        .map_err(|error| match error {
            InProcessError::GatewayStopped => SelfApiError::Unavailable,
            InProcessError::Join(_) | InProcessError::InvalidRequest(_) => SelfApiError::Unknown,
        })?;
        Ok(SelfResponse { response, deadline })
    }
}

impl SelfResponse {
    pub(crate) fn status(&self) -> StatusCode {
        self.response.status()
    }

    pub(crate) async fn bytes(self) -> Result<Bytes, SelfBodyError> {
        let read = to_bytes(self.response.into_body(), usize::MAX);
        match self.deadline {
            Some(deadline) => timeout_at(deadline, read)
                .await
                .map_err(|_| SelfBodyError)?,
            None => read.await,
        }
        .map_err(|_| SelfBodyError)
    }
}
