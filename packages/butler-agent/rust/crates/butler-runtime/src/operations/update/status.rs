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
        let previews = super::channel::previews(&self.data, None, self.version.as_deref()).await;
        let saved = self
            .saved()
            .await
            .filter(|view| channel_matches(view, previews));
        if saved.as_ref().is_none_or(is_stale) {
            self.refresh_in_background();
        }
        match saved {
            Some(view) => {
                let mut view = reconciled(view, version);
                view["progress"] = self.progress.snapshot().await;
                Ok(view)
            }
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
                let mut view = self.view(&request, &status);
                view["progress"] = self.progress.snapshot().await;
                Ok(view)
            }
        }
    }

    /// Checks the manifest now (`POST /updates/check`). A manifest that is
    /// unreachable, incompatible or invalid is a saved status
    /// (`check_state: "unavailable"`), not a failure.
    pub async fn refresh(&self, request: UpdateRequest) -> Result<Value, UpdateError> {
        let _check = self.checks.lock().await;
        if self.version.is_none() {
            return Err(UpdateCode::AppVersionUnavailable.into());
        }
        let prior = self.progress.snapshot().await;
        if matches!(
            prior["stage"].as_str(),
            Some("ready" | "applying" | "restarting")
        ) {
            return self.current().await;
        }
        self.progress.report("checking", None, None, None).await?;
        let result = self.refresh_now(self.resolved_request(request).await).await;
        // Checking a feed is not a download/install attempt. Keep diagnostics
        // in check_state/check_error and let unavailable statuses retry quietly.
        self.progress.report("completed", None, None, None).await?;
        match result {
            Ok(mut view) => {
                view["progress"] = self.progress.snapshot().await;
                Ok(view)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn resolved_request(&self, mut request: UpdateRequest) -> UpdateRequest {
        let previews = super::channel::previews(
            &self.data,
            request.channel.as_deref(),
            self.version.as_deref(),
        )
        .await;
        request.channel = Some(if previews { "preview" } else { "stable" }.into());
        request
    }

    async fn refresh_now(&self, request: UpdateRequest) -> Result<Value, UpdateError> {
        match self.check_now(request.clone()).await {
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
            let _check = this.checks.lock().await;
            let request = this.resolved_request(UpdateRequest::default()).await;
            let previews = request.channel.as_deref() == Some("preview");
            if this
                .saved()
                .await
                .is_none_or(|view| is_stale(&view) || !channel_matches(&view, previews))
            {
                let _ = this.refresh_now(request).await;
            }
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
            Some(prior)
                if super::channel::eligible(
                    &json!({"version": prior.get("available_version")}),
                    super::channel::previews(
                        &self.data,
                        request.channel.as_deref(),
                        self.version.as_deref(),
                    )
                    .await,
                ) =>
            {
                Value::Object(prior)
            }
            _ => {
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

fn channel_matches(view: &Value, previews: bool) -> bool {
    let eligible = previews
        || view["components"][0]["update_available"] != true
        || view["components"][0]["available_version"]
            .as_str()
            .and_then(|version| semver::Version::parse(version).ok())
            .is_some_and(|version| version.pre.is_empty());
    eligible
        && view
            .get("receive_previews")
            .and_then(Value::as_bool)
            .is_none_or(|prior| prior == previews)
}

/// Failures that leave the status calm: no usable manifest, not a broken
/// install.
fn error_is_calm(code: &str) -> bool {
    code.starts_with("update_manifest_")
        || matches!(
            code,
            "update_signature_unsupported"
                | "update_http_unavailable"
                | "update_artifact_source_invalid"
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
