use super::*;
use serde_json::{Value, json as value};
pub(super) async fn command(
    method: Method,
    uri: &Uri,
    request: Request<Body>,
) -> Result<(String, Option<String>, Value), HttpError> {
    let parts = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let revision = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(k, _)| k == "revision")
        .and_then(|(_, v)| v.parse::<u64>().ok());
    let input = if matches!(method, Method::POST | Method::PATCH) {
        let bytes = read_body_with_limit(request.into_body(), super::MAX_REQUEST_BODY_SIZE).await?;
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?
    } else {
        value!({"revision":revision})
    };
    let (action, id) = match (method.as_str(), parts.as_slice()) {
        ("GET", ["connectors"]) => ("connector_list", None),
        ("GET", ["connector-rules"]) => ("connector_rules", None),
        ("DELETE", ["connector-rules", id]) => ("connector_rule_delete", Some((*id).into())),
        ("PATCH", ["connector-rules", id]) => ("connector_rule_patch", Some((*id).into())),
        ("POST", ["connectors", plugin, connector, "accounts"]) => {
            ("connector_connect", Some(format!("{plugin}/{connector}")))
        }
        ("PATCH", ["connectors", plugin, connector, "accounts", account]) => (
            "connector_patch",
            Some(format!("{plugin}/{connector}/{account}")),
        ),
        ("DELETE", ["connectors", plugin, connector, "accounts", account]) => (
            "connector_disconnect",
            Some(format!("{plugin}/{connector}/{account}")),
        ),
        (
            "POST",
            [
                "connectors",
                plugin,
                connector,
                "accounts",
                account,
                "retry",
            ],
        ) => (
            "connector_retry",
            Some(format!("{plugin}/{connector}/{account}")),
        ),
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    Ok((action.into(), id, input))
}
