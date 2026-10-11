//! Local client for the App schedule service, shared by CLI and chat tools.

use std::{path::Path, time::Duration};

use reqwest::Method;
use serde_json::{Map, Value, json};

use crate::host::{ActiveAppEndpoint, service::configuration::AppServiceConfiguration};

#[derive(Debug)]
pub(crate) struct ScheduleError {
    code: String,
    message: String,
}

impl ScheduleError {
    pub(crate) fn code(&self) -> &str {
        &self.code
    }
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

pub(crate) struct ScheduleClient {
    base_url: String,
    token: std::sync::Arc<str>,
    http: reqwest::Client,
}

impl ScheduleClient {
    pub(crate) fn active(endpoint: &ActiveAppEndpoint) -> Result<Self, ScheduleError> {
        let snapshot = endpoint.snapshot().ok_or_else(unavailable)?;
        let token = snapshot.local_auth.token().ok_or_else(unavailable)?;
        Self::new(
            snapshot
                .base_url
                .replace("http://0.0.0.0:", "http://127.0.0.1:"),
            token,
        )
    }

    pub(crate) fn local(data_root: &Path) -> Result<Self, ScheduleError> {
        let app = AppServiceConfiguration::capture(data_root);
        let token = app
            .gateway_config()
            .local_auth
            .token()
            .ok_or_else(unavailable)?;
        Self::new(format!("http://127.0.0.1:{}", app.port), token)
    }

    fn new(base_url: String, token: std::sync::Arc<str>) -> Result<Self, ScheduleError> {
        Ok(Self {
            base_url,
            token,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| unavailable())?,
        })
    }

    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ScheduleError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base_url))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| unavailable())?;
        let status = response.status();
        let body: Value = response.json().await.map_err(|_| unavailable())?;
        if !status.is_success() {
            return Err(ScheduleError {
                code: body
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("schedule_request_failed")
                    .to_owned(),
                message: body
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Schedule request failed.")
                    .to_owned(),
            });
        }
        body.get("data").cloned().ok_or_else(unavailable)
    }

    pub(crate) async fn tool(
        &self,
        name: &str,
        args: Map<String, Value>,
        session: &str,
    ) -> Result<Value, ScheduleError> {
        let id = args.get("id").and_then(Value::as_str).unwrap_or("");
        if matches!(name, "update_automation" | "delete_automation") && !safe_id(id) {
            return Err(ScheduleError {
                code: "schedule_id_invalid".into(),
                message: "Schedule id is invalid.".into(),
            });
        }
        let path = |suffix: &str| format!("/automations/{id}{suffix}");
        let data = match name {
            "create_automation" => {
                let prompt = args.get("prompt").and_then(Value::as_str).unwrap_or("");
                let kind = args
                    .get("schedule_type")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let seconds = args
                    .get("interval_minutes")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .saturating_mul(60);
                self.request(Method::POST, "/automations", Some(json!({
                    "id": args.get("id"), "title": args.get("title").and_then(Value::as_str).unwrap_or(prompt),
                    "prompt_body": prompt, "target_session_id": args.get("session_id").and_then(Value::as_str).unwrap_or(session),
                    "schedule_type": kind, "run_at": args.get("run_at"), "start_at": args.get("start_at"),
                    "interval_seconds": seconds,
                    "access_mode": args.get("access_mode"),
                    "source_session_id": session,
                }))).await?
            }
            "list_automations" => {
                let path = if args.get("include_deleted").and_then(Value::as_bool) == Some(true) {
                    "/automations?include_deleted=true"
                } else {
                    "/automations"
                };
                self.request(Method::GET, path, None).await?
            }
            "update_automation" => {
                self.request(Method::PATCH, &path(""), Some(Value::Object(args)))
                    .await?
            }
            "delete_automation" => self.request(Method::DELETE, &path(""), None).await?,
            "run_due_automations" => {
                self.request(Method::POST, "/automations/dispatch-due", Some(json!({})))
                    .await?
            }
            _ => {
                return Err(ScheduleError {
                    code: "schedule_tool_unknown".into(),
                    message: "Schedule tool unavailable.".into(),
                });
            }
        };
        let mut result = data.as_object().cloned().unwrap_or_default();
        result.insert("ok".into(), Value::Bool(true));
        Ok(Value::Object(result))
    }
}

fn unavailable() -> ScheduleError {
    ScheduleError {
        code: "schedule_unavailable".into(),
        message: "Butler schedule service is unavailable.".into(),
    }
}

fn safe_id(id: &str) -> bool {
    (1..=100).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
