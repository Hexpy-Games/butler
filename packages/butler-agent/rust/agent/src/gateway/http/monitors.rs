//! HTTP adapters for the read-only Desktop monitors.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppDeveloperLogsQuery, AppMonitorPage, AppUsageMonitorQuery, AppWorkerActivityQuery,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    if request.method() == Method::POST
        && let Some(encoded_id) = uri
            .path()
            .strip_prefix("/worker-activity/")
            .and_then(|value| value.strip_suffix("/control"))
            .filter(|value| !value.is_empty() && !value.contains('/'))
    {
        let worker_id = decode_component(encoded_id)?;
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
        let action = body
            .as_object()
            .and_then(|object| object.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("cancel");
        let worker = worker_detail(&state, &worker_id).await?;
        let advertised = worker
            .get("supported_controls")
            .and_then(Value::as_array)
            .is_some_and(|controls| {
                controls
                    .iter()
                    .any(|control| control.as_str() == Some(action))
            });
        // The native worker projection currently advertises no controls.
        // A supported action requires an actual owner operation before success is possible.
        let code = if advertised {
            "worker_control_unavailable"
        } else {
            "worker_control_unsupported"
        };
        return Err(HttpError::public(
            409,
            code,
            "Worker control is not supported.",
        ));
    }
    if request.method() != Method::GET {
        return Err(HttpError::public(404, "not_found", "Route not found."));
    }
    let parameters = query(uri);
    let path = uri.path();
    let data = match path {
        "/usage-monitor" => {
            state
                .application
                .get_usage_monitor(usage_query(&parameters))
                .await?
        }
        "/work-status" => crate::gateway::app_work_status(&*state.application).await?,
        "/system-events" => {
            state
                .application
                .list_system_events(AppMonitorPage {
                    limit: positive_integer(parameters.get("limit")),
                    offset: nonnegative_integer(parameters.get("offset")),
                })
                .await?
        }
        "/developer-logs" => {
            let settings = state.application.read_settings().await?;
            if settings.get("diagnostics_enabled").and_then(Value::as_bool) != Some(true) {
                return Err(HttpError::public(
                    403,
                    "developer_mode_required",
                    "Developer mode is required to view model diagnostics.",
                ));
            }
            state
                .application
                .list_developer_logs(AppDeveloperLogsQuery {
                    limit: positive_integer(parameters.get("limit")),
                    offset: nonnegative_integer(parameters.get("offset")),
                    session_id: parameters
                        .get("session_id")
                        .filter(|value| !value.is_empty())
                        .cloned(),
                    turn_id: parameters
                        .get("turn_id")
                        .filter(|value| !value.is_empty())
                        .cloned(),
                    kind: parameters.get("kind").cloned(),
                    query: parameters.get("query").cloned(),
                })
                .await?
        }
        "/worker-activity" => {
            crate::gateway::app_worker_activity(
                &*state.application,
                AppWorkerActivityQuery {
                    session_id: None,
                    include_history: parameters
                        .get("include_history")
                        .is_some_and(|v| v == "true"),
                    limit: page_limit(parameters.get("limit"), 200, 1, 200),
                    offset: page_limit(parameters.get("offset"), 0, 0, 200),
                    cursor: parameters.get("cursor").cloned(),
                },
            )
            .await?
        }
        _ if path.starts_with("/worker-activity/") => {
            let encoded_id = path.strip_prefix("/worker-activity/").unwrap_or_default();
            if encoded_id.is_empty() || encoded_id.contains('/') {
                return Err(HttpError::public(404, "not_found", "Route not found."));
            }
            let worker_id = decode_component(encoded_id)?;
            worker_detail(&state, &worker_id).await?
        }
        _ if path.starts_with("/sessions/") => {
            let (session_id, include_history) = session_activity_path(path)
                .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
            crate::gateway::app_worker_activity(
                &*state.application,
                AppWorkerActivityQuery {
                    session_id: Some(session_id),
                    include_history,
                    limit: page_limit(parameters.get("limit"), 200, 1, 200),
                    offset: page_limit(parameters.get("offset"), 0, 0, 200),
                    cursor: parameters.get("cursor").cloned(),
                },
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

async fn worker_detail(state: &HttpState, worker_id: &str) -> Result<Value, HttpError> {
    let mut cursor = None;
    loop {
        let view = crate::gateway::app_worker_activity(
            &*state.application,
            AppWorkerActivityQuery {
                session_id: None,
                include_history: true,
                limit: Some(200),
                offset: Some(0),
                cursor: cursor.clone(),
            },
        )
        .await?;
        if let Some(worker) = view
            .get("workers")
            .and_then(Value::as_array)
            .and_then(|workers| {
                workers.iter().find(|worker| {
                    worker.get("worker_id").and_then(Value::as_str) == Some(worker_id)
                })
            })
            .cloned()
        {
            return Ok(worker);
        }
        let pagination = view.get("pagination");
        if pagination
            .and_then(|value| value.get("has_more"))
            .and_then(Value::as_bool)
            != Some(true)
        {
            break;
        }
        let Some(next_cursor) = pagination
            .and_then(|value| value.get("next_cursor"))
            .and_then(Value::as_str)
            .filter(|next| Some(*next) != cursor.as_deref())
        else {
            break;
        };
        cursor = Some(next_cursor.to_owned());
    }
    Err(HttpError::public(
        404,
        "worker_not_found",
        "Worker activity not found.",
    ))
}

fn usage_query(parameters: &std::collections::HashMap<String, String>) -> AppUsageMonitorQuery {
    let session_id = parameters
        .get("session_id")
        .or_else(|| parameters.get("sessionId"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let hours = parameters
        .get("since_hours")
        .or_else(|| parameters.get("sinceHours"))
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|hours| hours.is_finite() && *hours > 0.0);
    AppUsageMonitorQuery {
        session_id,
        since_ts: hours
            .map(|hours| chrono::Utc::now().timestamp_millis() as f64 - hours * 3_600_000.0),
    }
}

fn positive_integer(value: Option<&String>) -> Option<usize> {
    number(value)
        .filter(|value| *value >= 1.0)
        .map(|value| value.floor().min(usize::MAX as f64) as usize)
}

fn nonnegative_integer(value: Option<&String>) -> Option<usize> {
    number(value)
        .filter(|value| *value >= 0.0)
        .map(|value| value.floor().min(usize::MAX as f64) as usize)
}

fn number(value: Option<&String>) -> Option<f64> {
    value?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn page_limit(
    value: Option<&String>,
    fallback: usize,
    minimum: usize,
    maximum: usize,
) -> Option<usize> {
    number(value)
        .map(|value| (value.floor().max(minimum as f64).min(maximum as f64)) as usize)
        .or(Some(fallback))
}

fn session_activity_path(path: &str) -> Option<(String, bool)> {
    let tail = path.strip_prefix("/sessions/")?;
    let (encoded, suffix) = tail.split_once("/worker-activity")?;
    if encoded.is_empty() || !matches!(suffix, "" | "/history") {
        return None;
    }
    Some((decode_component(encoded).ok()?, suffix == "/history"))
}

fn decode_component(value: &str) -> Result<String, HttpError> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let (Some(high), Some(low)) = (input.next().and_then(hex), input.next().and_then(hex))
            else {
                return Err(HttpError::Internal);
            };
            bytes.push((high << 4) | low);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).map_err(|_| HttpError::Internal)
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}
