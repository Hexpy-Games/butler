//! `list_wallpapers` and `set_wallpaper` over the App gateway's
//! `/internal/wallpaper`, and `save_wallpaper_module` over
//! `/internal/wallpaper-modules`. Every failure is a model-readable
//! `{ok: false, error: {code, message, field?, allowed?}}`.
//!
//! `set_wallpaper` is a turn-local preference write, like the onboarding
//! profile: it needs no Work or plan review and runs in every mode but
//! read-only, because the user sees the change at once and undoes it from the
//! App's toast (`wallpaper.changed`, origin "agent"). Writing a wallpaper is
//! idempotent (an attachment is promoted once), so a journaled call that was
//! interrupted is simply sent again. `current_project` resolves to this
//! Turn's App project here.
//!
//! `save_wallpaper_module` is turn-local the same way: it writes only the
//! user's wallpaper module folder, the gateway checks the module and writes
//! its files (manifest, shader and optional overlay) at once, and the result
//! carries the App's compile check of those files, so the model can fix the
//! shader and save again. Saving the same files twice is idempotent.

use std::time::Duration;

use reqwest::Method;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use butler_core::json::JsonDocument;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{AccessMode, BtccError, ModelRoundToolCall, ToolExecutionError};

use super::GuidedTools;
use crate::host::ActiveAppEndpoint;

pub(super) const ROUTE: &str = "/internal/wallpaper";
const MODULE_ROUTE: &str = "/internal/wallpaper-modules";

pub(super) fn supports(name: &str) -> bool {
    name == ToolName::ListWallpapers
        || name == ToolName::SetWallpaper
        || name == ToolName::SaveWallpaperModule
}

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    signal: &CancellationToken,
) -> Result<JsonDocument, ToolExecutionError> {
    let current = owner.binding.project_id.as_deref();
    let access = &owner.binding.access_mode;
    let result = if call.name == ToolName::SetWallpaper {
        set(
            &owner.app_endpoint,
            access,
            &call.arguments,
            current,
            signal,
        )
        .await
    } else if call.name == ToolName::SaveWallpaperModule {
        save(&owner.app_endpoint, access, &call.arguments, signal).await
    } else {
        let project = project(&call.arguments, current);
        let query: Vec<_> = project
            .iter()
            .map(|id| ("project_id", id.as_str()))
            .collect();
        overview(app_json(&owner.app_endpoint, Method::GET, &query, None, signal).await)
    };
    JsonDocument::from_value(&result).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed(
            "guided_tool_result_json",
            error.to_string(),
        ))
    })
}

/// `{ok: true, scope, projectId?, previous, next, changed}` or a failure;
/// nothing is sent for a read-only Turn or invalid arguments.
async fn set(
    endpoint: &ActiveAppEndpoint,
    access: &AccessMode,
    arguments: &Map<String, Value>,
    current_project: Option<&str>,
    signal: &CancellationToken,
) -> Value {
    if *access == AccessMode::ReadOnly {
        return failure(
            "read_only",
            "This Turn has read-only access; no change was applied.",
        );
    }
    let body = match request(arguments, current_project) {
        Ok(body) => body,
        Err((code, message)) => return failure(code, message),
    };
    let reply = app_json(endpoint, Method::POST, &[], Some(&body), signal).await;
    written(reply, "The App returned no wallpaper change.")
}

/// `{ok: true, id, status}` with the App's check of the saved files, or a
/// failure; nothing is sent for a read-only Turn or a malformed call.
async fn save(
    endpoint: &ActiveAppEndpoint,
    access: &AccessMode,
    arguments: &Map<String, Value>,
    signal: &CancellationToken,
) -> Value {
    if *access == AccessMode::ReadOnly {
        return failure(
            "read_only",
            "This Turn has read-only access; the module was not saved.",
        );
    }
    if let Err((field, rule)) = module_shape(arguments) {
        return json!({"ok": false, "error": {"code": "wallpaper_module_invalid",
                      "message": format!("{field} {rule}."), "field": field}});
    }
    let mut body = json!({"id": arguments.get("id"), "manifest": arguments.get("manifest"),
                          "shader": arguments.get("shader")});
    if let Some(overlay) = arguments.get("overlay") {
        body["overlay"] = overlay.clone();
    }
    let reply = app_json_at(
        endpoint,
        MODULE_ROUTE,
        Method::POST,
        &[],
        Some(&body),
        signal,
    )
    .await;
    written(reply, "The App returned no saved module.")
}

/// The field and rule a save call breaks in its shape; the App checks the
/// module itself.
fn module_shape(arguments: &Map<String, Value>) -> Result<(), (&'static str, &'static str)> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty());
    if !id {
        return Err(("id", "is required: the module id, e.g. user.rainy-window"));
    }
    if !arguments.get("manifest").is_some_and(Value::is_object) {
        return Err((
            "manifest",
            "must be the wallpaper.json content as a JSON object",
        ));
    }
    if !arguments.get("shader").is_some_and(Value::is_string) {
        return Err(("shader", "must be the shader.frag text"));
    }
    if arguments
        .get("overlay")
        .is_some_and(|overlay| !overlay.is_string())
    {
        return Err(("overlay", "must be the overlay.frag text"));
    }
    Ok(())
}

/// A write's reply: `{ok: true, ..data}`, a correctable refusal with its
/// field and allowed values, or a failure.
fn written(reply: Result<(u16, Value), AppCallError>, empty: &str) -> Value {
    match reply {
        Ok((status, body)) if (200..300).contains(&status) => match body.get("data") {
            Some(Value::Object(data)) => {
                let mut result = Map::from_iter([("ok".to_owned(), json!(true))]);
                result.extend(data.clone());
                Value::Object(result)
            }
            _ => failure("wallpaper_response_invalid", empty),
        },
        Ok((status, body)) if status < 500 && body["error"]["message"].is_string() => {
            json!({"ok": false, "error": body["error"]})
        }
        Ok((_, body)) => {
            let (code, message) = app_error(&body);
            failure(&code, &message)
        }
        Err(error) => failure(error.code, error.message()),
    }
}

/// The App request for the arguments: `{scope, project_id?, source}` with
/// `current_project` resolved.
fn request(
    arguments: &Map<String, Value>,
    current_project: Option<&str>,
) -> Result<Value, (&'static str, &'static str)> {
    let text = |key| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let project = match text("scope") {
        Some("global") => None,
        Some("current_project") => Some(current_project.ok_or((
            "wallpaper_no_current_project",
            "This conversation belongs to no project. Use scope \"global\", or scope \
             \"project\" with a project_id.",
        ))?),
        Some("project") => Some(text("project_id").ok_or((
            "wallpaper_project_id_required",
            "project_id is required for scope \"project\".",
        ))?),
        _ => {
            return Err((
                "wallpaper_scope_invalid",
                "scope must be \"global\", \"current_project\" or \"project\".",
            ));
        }
    };
    let source = arguments
        .get("source")
        .cloned()
        .ok_or(("wallpaper_source_required", "source is required."))?;
    Ok(match project {
        None => json!({"scope": "global", "source": source}),
        Some(id) => json!({"scope": "project", "project_id": id, "source": source}),
    })
}

fn project(arguments: &Map<String, Value>, current: Option<&str>) -> Option<String> {
    arguments
        .get("project_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .or(current)
        .map(str::to_owned)
}

/// `{ok: true, ..overview}` or `{ok: false, error}`.
fn overview(reply: Result<(u16, Value), AppCallError>) -> Value {
    match reply {
        Ok((status, body)) if (200..300).contains(&status) => match body.get("data") {
            Some(Value::Object(data)) => {
                let mut result = Map::from_iter([("ok".to_owned(), json!(true))]);
                result.extend(data.clone());
                Value::Object(result)
            }
            _ => failure(
                "wallpaper_response_invalid",
                "The App returned no wallpaper overview.",
            ),
        },
        Ok((_, body)) => {
            let (code, message) = app_error(&body);
            failure(&code, &message)
        }
        Err(error) => failure(error.code, error.message()),
    }
}

fn failure(code: &str, message: &str) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message}})
}

/// The App's `{error: {code, message}}`, or a generic pair.
pub(super) fn app_error(body: &Value) -> (String, String) {
    let error = body.get("error");
    let text = |key: &str| {
        error
            .and_then(|error| error.get(key))
            .and_then(Value::as_str)
    };
    (
        text("code")
            .unwrap_or("wallpaper_request_failed")
            .to_owned(),
        text("message")
            .unwrap_or("The App refused the wallpaper request.")
            .to_owned(),
    )
}

/// Why a call to the App produced no response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct AppCallError {
    pub(super) code: &'static str,
    /// The request may have reached the App.
    pub(super) sent: bool,
}

impl AppCallError {
    pub(super) fn message(&self) -> &'static str {
        match self.code {
            "app_gateway_unavailable" => "The App is not running; the wallpaper cannot be reached.",
            "app_local_auth_unconfigured" => "The App endpoint has no local credentials.",
            "wallpaper_cancelled" => "The request was cancelled before it was sent.",
            "wallpaper_response_invalid" => "The App answered with unreadable JSON.",
            _ => "The App did not answer; the outcome is unknown.",
        }
    }
}

/// One JSON request to the App's wallpaper route.
pub(super) async fn app_json(
    endpoint: &ActiveAppEndpoint,
    method: Method,
    query: &[(&str, &str)],
    body: Option<&Value>,
    signal: &CancellationToken,
) -> Result<(u16, Value), AppCallError> {
    app_json_at(endpoint, ROUTE, method, query, body, signal).await
}

/// One JSON request to `route` of the live App endpoint (never a pending
/// configuration): its status and decoded body.
async fn app_json_at(
    endpoint: &ActiveAppEndpoint,
    route: &str,
    method: Method,
    query: &[(&str, &str)],
    body: Option<&Value>,
    signal: &CancellationToken,
) -> Result<(u16, Value), AppCallError> {
    let unsent = |code| AppCallError { code, sent: false };
    if signal.is_cancelled() {
        return Err(unsent("wallpaper_cancelled"));
    }
    let current = endpoint
        .snapshot()
        .ok_or_else(|| unsent("app_gateway_unavailable"))?;
    let auth = current.local_auth;
    if auth.required && auth.token().is_none() {
        return Err(unsent("app_local_auth_unconfigured"));
    }
    let mut request = reqwest::Client::new()
        .request(method, format!("{}{route}", current.base_url))
        .query(query)
        .timeout(Duration::from_secs(60));
    if let Some(token) = auth.token() {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let unknown = AppCallError {
        code: "wallpaper_outcome_unknown",
        sent: true,
    };
    let response = tokio::select! {
        biased;
        () = signal.cancelled() => return Err(unknown),
        response = request.send() => response.map_err(|_| unknown)?,
    };
    let status = response.status().as_u16();
    let decoded = tokio::select! {
        biased;
        () = signal.cancelled() => return Err(unknown),
        decoded = response.json::<Value>() => decoded,
    };
    decoded
        .map(|body| (status, body))
        .map_err(|_| AppCallError {
            code: "wallpaper_response_invalid",
            sent: true,
        })
}

#[cfg(test)]
pub(super) mod tests;
