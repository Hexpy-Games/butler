//! The App update status a client reads: the last saved check, answered
//! without touching the network, and refreshed in the background once stale.

use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use super::{
    AppUpdateService, UpdateCode, UpdateError, UpdateRequest, manifest::AppArtifact, stage,
};

/// A saved check older than this is refreshed in the background.
const STALE_AFTER_MS: i64 = 6 * 60 * 60 * 1_000;
/// A check that could not reach a usable manifest is tried again sooner.
const RETRY_AFTER_MS: i64 = 30 * 60 * 1_000;
pub(super) const STATUS_LABEL: &str = "updates/status.json";

impl AppUpdateService {
    /// The last saved status (`GET /updates`). Never waits for the manifest:
    /// a missing or stale status starts one background check, and a status
    /// never checked reads as up to date with `check_state: "unchecked"`.
    pub async fn current(&self) -> Result<Value, UpdateError> {
        let version = self
            .version
            .as_deref()
            .ok_or(UpdateCode::AppVersionUnavailable)?;
        let saved = self.saved().await;
        if saved.as_ref().is_none_or(is_stale) {
            self.refresh_in_background();
        }
        match saved {
            Some(view) => Ok(reconciled(view, version)),
            None => {
                let request = UpdateRequest::default();
                let status = self
                    .status(
                        &request,
                        &self.unchecked_artifact(&request, version),
                        "unchecked",
                        None,
                    )
                    .await?;
                Ok(self.view(&request, &status))
            }
        }
    }

    /// Checks the manifest now (`POST /updates/check`). A manifest that is
    /// unreachable, incompatible or invalid is a saved status
    /// (`check_state: "unavailable"`), not a failure.
    pub async fn refresh(&self, request: UpdateRequest) -> Result<Value, UpdateError> {
        match self.check(request.clone()).await {
            Err(error) if error_is_calm(error.code()) => {
                self.persist_unavailable(&request, error.code()).await
            }
            other => other,
        }
    }

    /// The saved App status; the Agent updater saves its own to the same file.
    async fn saved(&self) -> Option<Value> {
        stage::read_json(&self.data, &self.installation, STATUS_LABEL)
            .await
            .filter(|view| view["components"][0]["component"] == "app")
    }

    fn refresh_in_background(&self) {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let _ = this.refresh(UpdateRequest::default()).await;
            this.refreshing.store(false, Ordering::Release);
        });
    }

    async fn persist_unavailable(
        &self,
        request: &UpdateRequest,
        code: &str,
    ) -> Result<Value, UpdateError> {
        let version = self
            .version
            .as_deref()
            .ok_or(UpdateCode::AppVersionUnavailable)?;
        let saved = self.saved().await;
        let mut status = match saved.and_then(|view| view["components"][0].as_object().cloned()) {
            Some(prior) => Value::Object(prior),
            None => {
                self.status(
                    request,
                    &self.unchecked_artifact(request, version),
                    "unavailable",
                    Some(code),
                )
                .await?
            }
        };
        status["check_state"] = json!("unavailable");
        status["check_error"] = json!(code);
        status["checked_at"] = json!(now());
        let view = self.persist_status(request, status).await?;
        Ok(reconciled(view, version))
    }

    /// What is known of the installed version when the manifest is not.
    fn unchecked_artifact(&self, request: &UpdateRequest, version: &str) -> AppArtifact {
        AppArtifact {
            version: version.into(),
            channel: request.channel.clone().unwrap_or_else(|| "stable".into()),
            platform: butler_platform::launcher::release_platform(),
            url: None,
            sha256: None,
            bundled_agent_version: None,
            protocol_compatibility: json!({
                "protocol":"butler.app.v1", "minimumAppProtocol":"butler.app.v1", "maximumAppProtocol":"butler.app.v1"
            }),
        }
    }
}

/// Failures that leave the status calm: no usable manifest, not a broken
/// install.
fn error_is_calm(code: &str) -> bool {
    code.starts_with("update_manifest_")
        || matches!(
            code,
            "update_signature_unsupported" | "update_http_unavailable"
        )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn is_stale(view: &Value) -> bool {
    let Some(checked) = view["generated_at"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
    else {
        return true;
    };
    let age = chrono::Utc::now().timestamp_millis() - checked.timestamp_millis();
    let limit = match view["components"][0]["check_state"].as_str() {
        Some("unchecked" | "unavailable") => RETRY_AFTER_MS,
        _ => STALE_AFTER_MS,
    };
    age >= limit
}

/// The saved status against the version running now: the app may have been
/// updated since the check.
fn reconciled(mut view: Value, version: &str) -> Value {
    if let Some(status) = view["components"].get_mut(0) {
        status["current_version"] = json!(version);
        let available = status["available_version"].as_str().unwrap_or(version);
        status["update_available"] = json!(super::version_newer(available, version));
        if status.get("check_state").is_none() {
            status["check_state"] = json!("ok");
        }
    }
    view
}
