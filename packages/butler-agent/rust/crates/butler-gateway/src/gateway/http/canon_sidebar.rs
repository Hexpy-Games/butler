use super::router::Handler;
use super::*;

pub(super) const ROUTES: &[(&str, Handler)] = &[
    ("/canon/epics/{id}/conversation", Handler::CanonSidebar),
    ("/projects/{id}/canon/sidebar", Handler::CanonSidebar),
    ("/projects/{id}/canon/sidebar-order", Handler::CanonSidebar),
];
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    use crate::gateway::{AppWorkModelRequest, AppWorkModelResource};
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    let (resource, id) = match (request.method(), parts.as_slice()) {
        (&Method::POST, ["canon", "epics", id, "conversation"]) => {
            (AppWorkModelResource::Conversation, *id)
        }
        (&Method::GET, ["projects", id, "canon", "sidebar"]) => {
            (AppWorkModelResource::Sidebar, *id)
        }
        (&Method::POST, ["projects", id, "canon", "sidebar-order"]) => {
            (AppWorkModelResource::SidebarOrder, *id)
        }
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    let id = subsessions::decode_component(id)?;
    let input = if resource == AppWorkModelResource::SidebarOrder {
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        Some(serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?)
    } else {
        None
    };
    let data = state
        .application
        .work_model(AppWorkModelRequest {
            resource,
            id,
            input,
        })
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
