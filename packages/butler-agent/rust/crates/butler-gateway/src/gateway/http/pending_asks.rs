//! Authenticated registry reads and nonblocking question dismissal.
use super::*;
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let uri = request.uri();
    let parts = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let data = match (request.method(), parts.as_slice()) {
        (&Method::GET, ["pending-asks"]) => {
            let query = query(uri);
            let limit = query
                .get("limit")
                .map(|s| s.parse::<usize>())
                .transpose()
                .map_err(|_| HttpError::public(400, "invalid_limit", "Invalid page size."))?
                .unwrap_or(50);
            state
                .application
                .pending_asks(None, limit, query.get("before").cloned())
                .await?
        }
        (&Method::GET, ["sessions", session, "pending-asks"]) => {
            state
                .application
                .pending_asks(Some(authority::decode_component(session)?), 50, None)
                .await?
        }
        (&Method::POST, ["sessions", session, "pending-asks", ask, "dismiss"]) => {
            state
                .application
                .dismiss_pending_ask(
                    authority::decode_component(session)?,
                    authority::decode_component(ask)?,
                )
                .await?
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
