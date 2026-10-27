//! Contract validation before backend choice or native dispatch.
use super::{HttpError, HttpState, error};
use serde_json::{Value, json};
pub(super) fn validate(
    state: &HttpState,
    frame: &mut Value,
    op: &str,
    session: &str,
) -> Result<(), HttpError> {
    if session.is_empty()
        || session.len() > 128
        || !session
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(error(400, "invalid_session"));
    }
    validate_op(op)?;
    super::assets::validate(op, &frame["args"])?;
    if op == "tab.open" {
        let raw = frame["args"]["url"].as_str().unwrap_or("").to_owned();
        let content = url::Url::parse(&raw).ok().filter(|u| {
            u.host_str() == Some("127.0.0.1")
                && u.port() == Some(super::super::content::port(state))
                && u.scheme() == "http"
                && u.username().is_empty()
                && u.password().is_none()
                && (u.path().starts_with("/__o/")
                    || super::super::content::preview::owner_id(state, session, &raw).is_some())
        });
        let url = match content {
            Some(url) => url,
            None => butler_runtime::browser::public_url(&raw)
                .map_err(|_| error(400, "navigation_denied"))?,
        };
        frame["args"]["policy"] = butler_runtime::browser::navigation_policy(
            &format!("http://127.0.0.1:{}", super::super::content::port(state)),
            url.as_str(),
        );
        if let Some(id) = super::super::content::preview::owner_id(state, session, &raw) {
            frame["args"]["preview_id"] = json!(id);
        }
        if state
            .previews
            .owned(session, frame["args"]["preview_id"].as_str().unwrap_or(""))
        {
            frame["args"]["policy"]["preview"] = json!(true);
        }
    }
    if op == "tab.act"
        && frame["args"]["steps"]
            .as_array()
            .is_none_or(|s| s.is_empty() || s.len() > 10)
    {
        return Err(error(400, "invalid_steps"));
    }
    Ok(())
}
fn validate_op(op: &str) -> Result<(), HttpError> {
    if !matches!(
        op,
        "tab.open"
            | "tab.observe"
            | "tab.read"
            | "tab.selection"
            | "tab.zoom"
            | "tab.screenshot"
            | "tab.image_collect"
            | "tab.prepare"
            | "tab.act"
            | "tab.dialog"
            | "tab.close"
            | "tabs.list"
            | "assets.lookup"
            | "images.resolve"
            | "images.store"
            | "images.usage"
            | "tab.wait"
            | "tab.waiting"
            | "tab.cancel"
            | "owner.closed"
            | "signin.lookup"
            | "signin.fill"
            | "signin.grant"
            | "pay.allow_site"
            | "pay.inspect"
            | "pay.lookup"
            | "pay.fill"
            | "autofill.fill"
    ) {
        return Err(error(400, "invalid_browser_op"));
    }
    Ok(())
}
