use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use axum::{
    http::{StatusCode, Uri},
    response::Response,
};

use super::{HttpError, HttpState, json, query};

pub(super) async fn route(
    state: std::sync::Arc<HttpState>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let data = match uri.path() {
        "/app-info" => state.application.read_app_info().await?,
        "/navigation" => state.application.read_navigation().await?,
        "/command-palette" => {
            let mut params = query(uri);
            let query_text = params.remove("query").unwrap_or_default();
            state.application.search_command_palette(query_text).await?
        }
        "/archives" => {
            let query = query(uri);
            let limit = positive_integer(query.get("limit"));
            let offset = nonnegative_integer(query.get("offset"));
            state.application.list_archives(limit, offset).await?
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

fn positive_integer(value: Option<&String>) -> Option<usize> {
    integer(value).filter(|value| *value >= 1)
}

fn nonnegative_integer(value: Option<&String>) -> Option<usize> {
    integer(value)
}

fn integer(value: Option<&String>) -> Option<usize> {
    let value = value?.parse::<f64>().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some(crate::json::saturating_usize(
        value.floor().min(usize::MAX as f64),
    ))
}
