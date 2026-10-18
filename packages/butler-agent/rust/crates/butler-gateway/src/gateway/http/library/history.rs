//! Authenticated history reads and explicit user deletion. Recording is main-only.
use super::*;
use crate::gateway::{AppHistoryCommand as C, AppHistoryQuery};
use chrono::{Local, Utc};
use serde_json::{Value, json};
fn invalid() -> HttpError {
    HttpError::public(400, "invalid_history_request", "Invalid history request.")
}
async fn body(request: Request<Body>) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 256 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
fn time(value: Option<&String>) -> Result<Option<i64>, HttpError> {
    value
        .map(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|t| t.timestamp_millis())
                .map_err(|_| invalid())
        })
        .transpose()
}
pub(in crate::gateway::http) async fn record(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let value = body(request).await?;
    let visits = value["visits"]
        .as_array()
        .filter(|v| v.len() <= 100)
        .ok_or_else(invalid)?
        .clone();
    reply(state, C::Record(visits)).await
}
pub(in crate::gateway::http) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let args = query(request.uri());
    let path = request.uri().path().to_owned();
    let command = match (request.method(), path.as_str()) {
        (&Method::GET, "/browser-history" | "/browser-history/search") => {
            C::Page(AppHistoryQuery {
                search: args.get("q").cloned().unwrap_or_default(),
                cursor: args.get("cursor").cloned().unwrap_or_default(),
                since: time(args.get("since"))?,
                until: time(args.get("until"))?,
                butler_only: args.get("butlerOnly").is_some_and(|s| s == "true"),
                limit: args
                    .get("limit")
                    .map(|s| s.parse::<usize>())
                    .transpose()
                    .map_err(|_| invalid())?
                    .unwrap_or(60)
                    .clamp(1, 60),
            })
        }
        (&Method::GET, "/browser-history/suggestions") => {
            C::Suggestions(args.get("q").cloned().unwrap_or_default())
        }
        (&Method::POST, "/browser-history/delete") => {
            let v = body(request).await?;
            C::Delete(
                v["ids"]
                    .as_array()
                    .filter(|ids| ids.len() <= 1000)
                    .ok_or_else(invalid)?
                    .iter()
                    .map(|id| id.as_i64().filter(|id| *id > 0).ok_or_else(invalid))
                    .collect::<Result<_, _>>()?,
            )
        }
        (&Method::POST, "/browser-history/delete-url") => {
            let v = body(request).await?;
            C::DeleteUrl(v["url"].as_str().ok_or_else(invalid)?.to_owned())
        }
        (&Method::POST, "/browser-history/clear") => {
            let v = body(request).await?;
            let mut until = Utc::now().timestamp_millis();
            let since = match v["range"].as_str() {
                Some("hour") => Some(until - 3_600_000),
                Some("today") => Some(
                    Local::now()
                        .date_naive()
                        .and_hms_opt(0, 0, 0)
                        .and_then(|t| t.and_local_timezone(Local).earliest())
                        .ok_or_else(invalid)?
                        .timestamp_millis(),
                ),
                Some("week") => Some(until - 7 * 86_400_000),
                Some("all") => {
                    until = i64::MAX;
                    None
                }
                _ => return Err(invalid()),
            };
            C::Clear {
                since,
                until,
                butler_only: v["butlerOnly"].as_bool().unwrap_or(false),
            }
        }
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    reply(state, command).await
}
async fn reply(state: Arc<HttpState>, command: C) -> Result<Response, HttpError> {
    let value = state
        .application
        .library(crate::gateway::AppLibraryCommand::History(command))
        .await?;
    json(
        StatusCode::OK,
        json!({"protocol_version":APP_PROTOCOL_VERSION,"data":value}),
    )
}

/// The headless backend has the same visibility/deletion store as the App.
pub(in crate::gateway::http) struct HeadlessHistory(pub std::sync::Weak<HttpState>);
impl butler_runtime::browser::HistoryPort for HeadlessHistory {
    fn record(&self, visits: Vec<Value>) -> butler_runtime::browser::VisitFuture {
        let state = self.0.upgrade();
        Box::pin(async move {
            let state = state.ok_or_else(|| "history_unavailable".to_owned())?;
            state
                .application
                .library(crate::gateway::AppLibraryCommand::History(C::Record(
                    visits,
                )))
                .await
                .map(drop)
                .map_err(|_| "history_unavailable".to_owned())
        })
    }
}
