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
    if super::canon::delegate(request.headers())?.is_some() {
        return Err(HttpError::public(
            403,
            "permission",
            "허용되지 않은 작업입니다.",
        ));
    }
    let parts: Vec<_> = uri.path().trim_start_matches('/').split('/').collect();
    let app = &state.application;
    let data = match (request.method(), parts.as_slice()) {
        (&Method::POST, ["canon", "epics", id, "conversation"]) => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Binding {
                session_id: Option<String>,
            }
            let id = subsessions::decode_component(id)?;
            let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            let input: Binding =
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            app.canon_conversation(id, input.session_id).await?
        }
        (&Method::GET, ["projects", id, "canon", "sidebar"]) => {
            app.canon_sidebar(subsessions::decode_component(id)?)
                .await?
        }
        (&Method::POST, ["projects", id, "canon", "sidebar-order"]) => {
            let id = subsessions::decode_component(id)?;
            let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            let input = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            app.canon_sidebar_order(id, input).await?
        }
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
