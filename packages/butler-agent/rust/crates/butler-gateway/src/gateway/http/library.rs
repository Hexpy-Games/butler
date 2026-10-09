//! Explicit saved-item commands over the existing authenticated App routes.
use super::*;
use crate::gateway::AppLibraryCommand;
use serde_json::{Value, json};
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let value = match method {
        Method::GET => {
            let args = query(request.uri());
            let kind = args.get("kind").cloned().unwrap_or_else(|| "scrap".into());
            let command = if let Some(url) = args.get("url") {
                AppLibraryCommand::Bookmark { url: url.clone() }
            } else {
                AppLibraryCommand::Page {
                    kind,
                    cursor: args.get("cursor").cloned().unwrap_or_default(),
                    search: args.get("q").cloned().unwrap_or_default(),
                }
            };
            state.application.library(command).await?
        }
        Method::POST => {
            let bytes = read_body_with_limit(request.into_body(), 10 * 1024 * 1024).await?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            if !valid(&value) {
                return Err(HttpError::public(
                    400,
                    "invalid_library_item",
                    "Invalid saved item.",
                ));
            }
            state
                .application
                .library(AppLibraryCommand::Save(value))
                .await?
        }
        Method::DELETE => {
            state
                .application
                .library(AppLibraryCommand::Delete {
                    id: path.trim_start_matches("/library/").to_owned(),
                })
                .await?
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
        json!({"protocol_version":APP_PROTOCOL_VERSION,"data":value}),
    )
}
fn valid(value: &Value) -> bool {
    let base = value["capturedAt"]
        .as_str()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        && ["id", "title", "url", "capturedAt"]
            .iter()
            .all(|key| value[*key].is_string())
        && value["id"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
        && value["title"].as_str().is_some_and(|s| s.len() <= 2000)
        && value["url"].as_str().is_some_and(|s| {
            url::Url::parse(s).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.username().is_empty()
                    && u.password().is_none()
            })
        });
    base && match value["kind"].as_str() {
        Some("scrap") => {
            value["text"].is_string()
                && value["crop"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("data:image/jpeg;base64,"))
        }
        Some("bookmark") => {
            value["folder"].is_null() || value["folder"].as_str().is_some_and(|s| s.len() <= 200)
        }
        _ => false,
    }
}
