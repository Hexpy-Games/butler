use axum::http::HeaderValue;
use axum::{
    body::Body,
    http::{StatusCode, header},
    response::Response,
};
use serde::Serialize;

use crate::gateway::{
    GatewayApplicationError,
    protocol::{APP_PROTOCOL_VERSION, ApiError, ApiErrorEnvelope},
};

pub(super) fn json<T: Serialize>(status: StatusCode, value: T) -> Result<Response, HttpError> {
    let bytes = serde_json::to_vec(&value).map_err(|_| HttpError::Internal)?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

pub(crate) enum HttpError {
    Public {
        status: u16,
        code: String,
        message: String,
    },
    PayloadTooLarge,
    Internal,
}

impl HttpError {
    pub(crate) fn public(status: u16, code: &str, message: &str) -> Self {
        Self::Public {
            status,
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }

    pub(super) fn invalid_json() -> Self {
        Self::public(400, "invalid_json", "Request body must be JSON.")
    }
}

impl From<GatewayApplicationError> for HttpError {
    fn from(error: GatewayApplicationError) -> Self {
        match error {
            GatewayApplicationError::Public {
                status,
                code,
                message,
            } => Self::Public {
                status,
                code,
                message,
            },
            GatewayApplicationError::Internal => Self::Internal,
        }
    }
}

pub(super) fn error_response(error: &HttpError) -> Response {
    if matches!(error, HttpError::PayloadTooLarge) {
        return super::payload_too_large_response();
    }
    let (status, code, message) = match &error {
        HttpError::Public {
            status,
            code,
            message,
        } => (*status, code.as_str(), message.as_str()),
        HttpError::PayloadTooLarge => (413, "payload_too_large", "Request body is too large."),
        HttpError::Internal => (500, "internal_error", "Request failed."),
    };
    let envelope = ApiErrorEnvelope {
        protocol_version: APP_PROTOCOL_VERSION,
        error: ApiError { code, message },
    };
    json(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        envelope,
    )
    .unwrap_or_else(|_| Response::new(Body::empty()))
}
