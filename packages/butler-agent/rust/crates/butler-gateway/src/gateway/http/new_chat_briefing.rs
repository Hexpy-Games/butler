use super::{HttpError, HttpState, json, query};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use axum::{
    http::{StatusCode, Uri},
    response::Response,
};
use std::sync::Arc;

pub(super) async fn get(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let query = query(uri);
    let view = state
        .application
        .new_chat_briefing(query.get("date").cloned(), query.get("project_id").cloned())
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: view,
        },
    )
}
