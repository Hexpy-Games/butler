//! Public Desktop project-dashboard routes over the App and Ledger owners.

use std::{collections::HashMap, sync::Arc};

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::{Value, json as json_value};

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, query, read_body_with_limit};
use crate::gateway::{
    AppProjectDashboardBriefingRequest, AppProjectDashboardPageQuery, AppProjectDashboardPinRef,
    AppProjectDashboardPreferencesUpdate, AppProjectDashboardRecordsQuery,
    AppProjectDashboardSourceQuery, AppProjectDashboardStatisticsQuery,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    let Some((encoded_id, resource)) = uri
        .path()
        .strip_prefix("/projects/")
        .and_then(|path| path.split_once("/dashboard"))
    else {
        return Ok(None);
    };
    if encoded_id.is_empty()
        || encoded_id.contains('/')
        || !matches!(
            resource,
            "" | "/records"
                | "/materials"
                | "/source"
                | "/history"
                | "/artifacts"
                | "/statistics"
                | "/preferences"
                | "/briefing"
                | "/attachment"
        )
    {
        return Ok(None);
    }
    let id = super::subsessions::decode_component(encoded_id)?;
    let parameters = query(uri);
    let method = request.method().clone();
    let (status, data) = match (method, resource) {
        (Method::GET, "") => (
            StatusCode::OK,
            state.application.get_project_dashboard(id).await?,
        ),
        (Method::GET, "/records") => {
            let kind = parameters.get("kind").map(String::as_str).unwrap_or("work");
            let lane = parameters.get("lane").cloned();
            let limit = page_limit(&parameters, 50)?;
            if !matches!(kind, "work" | "plan" | "task")
                || lane.as_deref().is_some_and(|v| {
                    !matches!(
                        v,
                        "planned" | "active" | "review" | "blocked" | "done" | "other"
                    )
                })
            {
                return Err(invalid("Invalid board query."));
            }
            let cursor = checked_cursor(&parameters)?;
            let data = state
                .application
                .get_project_dashboard_records(
                    id,
                    AppProjectDashboardRecordsQuery {
                        kind: kind.to_owned(),
                        parent: parameters.get("parent").cloned(),
                        cursor,
                        limit,
                        lane,
                    },
                )
                .await?;
            (StatusCode::OK, data)
        }
        (Method::GET, "/materials" | "/history" | "/artifacts") => {
            let page = AppProjectDashboardPageQuery {
                cursor: checked_cursor(&parameters)?,
                limit: page_limit(&parameters, 50)?,
                all: parameters.get("all").is_some_and(|v| v == "true"),
                important: parameters.get("important").is_some_and(|v| v == "true"),
            };
            let data = match resource {
                "/materials" => {
                    state
                        .application
                        .get_project_dashboard_materials(id, page)
                        .await?
                }
                "/history" => {
                    state
                        .application
                        .get_project_dashboard_history(id, page)
                        .await?
                }
                _ => {
                    state
                        .application
                        .get_project_dashboard_artifacts(id, page)
                        .await?
                }
            };
            (StatusCode::OK, data)
        }
        (Method::GET, "/source") => {
            let kind = parameters.get("kind").map(String::as_str).unwrap_or("");
            let source_id = parameters.get("id").map(String::as_str).unwrap_or("");
            let revision = parameters.get("revision").map(String::as_str).unwrap_or("");
            if !matches!(
                kind,
                "work" | "task" | "plan" | "spec" | "report" | "message" | "reference" | "artifact"
            ) || source_id.is_empty()
                || utf16_len(source_id) > 256
                || revision.is_empty()
                || utf16_len(revision) > 256
            {
                return Err(invalid("Invalid source query."));
            }
            let data = state
                .application
                .get_project_dashboard_source(
                    id,
                    AppProjectDashboardSourceQuery {
                        kind: kind.to_owned(),
                        id: source_id.to_owned(),
                        revision: revision.to_owned(),
                        cursor: checked_cursor(&parameters)?,
                    },
                )
                .await?;
            (StatusCode::OK, data)
        }
        (Method::GET, "/statistics") => {
            let period = parameters.get("days").map(String::as_str).unwrap_or("30");
            let period = period.parse::<u8>().map_err(|_| invalid_statistics())?;
            if !matches!(period, 7 | 30 | 90) {
                return Err(invalid_statistics());
            }
            let data = state
                .application
                .get_project_dashboard_statistics(
                    id,
                    AppProjectDashboardStatisticsQuery {
                        period,
                        timezone: parameters.get("timezone").cloned().unwrap_or_default(),
                    },
                )
                .await?;
            (StatusCode::OK, data)
        }
        (Method::PATCH, "/preferences") => {
            let value = body(request).await?;
            let object = value
                .as_object()
                .ok_or_else(|| invalid("Invalid preferences patch."))?;
            if object.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "expectedRevision" | "description" | "pinnedSourceRefs"
                )
            }) || object
                .get("expectedRevision")
                .is_none_or(|v| safe_nonnegative_integer(v).is_none())
                || (object.get("description").is_none() && object.get("pinnedSourceRefs").is_none())
                || object
                    .get("description")
                    .is_some_and(|v| v.as_str().is_none_or(|s| utf16_len(s) > 2000))
            {
                return Err(invalid("Invalid preferences patch."));
            }
            let pins = object.get("pinnedSourceRefs").map(parse_pins).transpose()?;
            let update = AppProjectDashboardPreferencesUpdate {
                expected_revision: safe_nonnegative_integer(&object["expectedRevision"])
                    .expect("validated preferences revision"),
                description: object
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                pinned_source_refs: pins,
            };
            (
                StatusCode::OK,
                state
                    .application
                    .update_project_dashboard_preferences(id, update)
                    .await?,
            )
        }
        (Method::POST, "/briefing") => {
            let value = body(request).await?;
            let object = value
                .as_object()
                .ok_or_else(|| invalid("Invalid briefing request."))?;
            let revision = object
                .get("sourceRevision")
                .and_then(Value::as_str)
                .unwrap_or("");
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "sourceRevision" | "retry"))
                || !digest(revision)
                || object.get("retry").is_some_and(|v| !v.is_boolean())
            {
                return Err(invalid("Invalid briefing request."));
            }
            let data = state
                .application
                .request_project_dashboard_briefing(
                    id,
                    AppProjectDashboardBriefingRequest {
                        source_revision: revision.to_owned(),
                        retry: object.get("retry").and_then(Value::as_bool) == Some(true),
                    },
                )
                .await?;
            (StatusCode::ACCEPTED, data)
        }
        (Method::POST, "/attachment") => {
            let value = body(request).await?;
            let object = value
                .as_object()
                .ok_or_else(|| invalid("Invalid artifact reference."))?;
            let artifact_id = object.get("id").and_then(Value::as_str).unwrap_or("");
            let revision = object.get("revision").and_then(Value::as_str).unwrap_or("");
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "id" | "revision"))
                || artifact_id.is_empty()
                || utf16_len(artifact_id) > 256
                || !digest(revision)
            {
                return Err(invalid("Invalid artifact reference."));
            }
            let file = state
                .application
                .attach_project_dashboard_artifact(id, artifact_id.to_owned(), revision.to_owned())
                .await?;
            (StatusCode::CREATED, json_value!({"file": file}))
        }
        _ => return Ok(None),
    };
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
    .map(Some)
}

fn checked_cursor(parameters: &HashMap<String, String>) -> Result<Option<String>, HttpError> {
    let cursor = parameters.get("cursor").cloned();
    if cursor.as_ref().is_some_and(|v| utf16_len(v) > 2048) {
        return Err(invalid("Invalid cursor."));
    }
    Ok(cursor)
}

fn page_limit(parameters: &HashMap<String, String>, default: usize) -> Result<usize, HttpError> {
    let Some(raw) = parameters.get("limit") else {
        return Ok(default);
    };
    let value = raw
        .parse::<usize>()
        .map_err(|_| invalid("Invalid limit."))?;
    if !(1..=100).contains(&value) {
        return Err(invalid("Invalid limit."));
    }
    Ok(value)
}

fn parse_pins(value: &Value) -> Result<Vec<AppProjectDashboardPinRef>, HttpError> {
    let rows = value
        .as_array()
        .ok_or_else(|| invalid("Invalid sources."))?;
    if rows.len() > 12 {
        return Err(invalid("Invalid sources."));
    }
    let mut pins = Vec::with_capacity(rows.len());
    for row in rows {
        let object = row
            .as_object()
            .ok_or_else(|| invalid("Invalid source reference."))?;
        let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
        let id = object.get("id").and_then(Value::as_str).unwrap_or("");
        let revision = object.get("revision").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            kind,
            "work" | "task" | "plan" | "spec" | "report" | "artifact"
        ) || id.is_empty()
            || utf16_len(id) > 256
            || !digest(revision)
            || pins
                .iter()
                .any(|pin: &AppProjectDashboardPinRef| pin.kind == kind && pin.id == id)
        {
            return Err(invalid("Invalid source reference."));
        }
        pins.push(AppProjectDashboardPinRef {
            kind: kind.to_owned(),
            id: id.to_owned(),
            revision: revision.to_owned(),
        });
    }
    Ok(pins)
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn safe_nonnegative_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite()
        && number.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&number))
    .then_some(number as u64)
}

async fn body(request: Request<Body>) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}

fn invalid(message: &'static str) -> HttpError {
    HttpError::public(400, "invalid_request", message)
}
fn invalid_statistics() -> HttpError {
    HttpError::public(400, "invalid_statistics_query", "Invalid period.")
}
