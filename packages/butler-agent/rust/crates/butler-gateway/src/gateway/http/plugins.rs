//! Local administrator package operations. Nothing here is exposed as a tool.
use super::*;
use serde_json::{Value, json as value};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    super::security_settings::local_client(request.extensions().get::<Client>())?;
    let client = request.extensions().get::<Client>();
    if !client.is_some_and(|c| c.admin) {
        return Err(HttpError::public(
            403,
            "admin_required",
            "Local admin credential required.",
        ));
    }
    let port = state
        .application
        .plugins()
        .ok_or_else(|| HttpError::public(404, "not_found", "Plugins unavailable."))?;
    let method = request.method().clone();
    let uri = request.uri().clone();
    let data = if method == Method::GET && uri.path() == "/plugins" {
        port.list().await.map_err(|e| failure(&e))?
    } else {
        let (action, id, input) = command(method, &uri, request).await?;
        let result = port
            .execute(action.clone(), id, input)
            .await
            .map_err(|e| failure(&e))?;
        if action != "inspect" {
            state
                .application
                .publish_gateway_event(
                    "plugins.changed",
                    result.as_object().cloned().unwrap_or_default(),
                )
                .await?;
        }
        result
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
async fn command(
    method: Method,
    uri: &Uri,
    request: Request<Body>,
) -> Result<(String, Option<String>, Value), HttpError> {
    let path = uri
        .path()
        .strip_prefix("/plugins/")
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    if method == Method::DELETE {
        let id = path.to_owned();
        let params: std::collections::HashMap<_, _> =
            url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
                .into_owned()
                .collect();
        let revision = params.get("revision").and_then(|v| v.parse::<u64>().ok());
        let data = match params.get("data").map(String::as_str) {
            None | Some("false") => false,
            Some("true") => true,
            _ => return Err(HttpError::invalid_json()),
        };
        return Ok((
            "uninstall".into(),
            Some(id),
            value!({"revision":revision,"data":data}),
        ));
    }
    if method != Method::POST {
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    let (action, id) = if matches!(path, "inspect" | "install") {
        (path, None)
    } else {
        let (id, action) = path.split_once('/').ok_or_else(HttpError::invalid_json)?;
        if !matches!(action, "enable" | "disable") {
            return Err(HttpError::invalid_json());
        }
        (action, Some(id.to_owned()))
    };
    let bytes = read_body_with_limit(request.into_body(), super::MAX_REQUEST_BODY_SIZE).await?;
    let input = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    Ok((action.into(), id, input))
}
fn failure(e: &butler_core::plugins::PluginError) -> HttpError {
    HttpError::public(e.status, e.code, e.code)
}
