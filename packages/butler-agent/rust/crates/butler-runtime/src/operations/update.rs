//! App-package update checks and DATA-only staging, and the Agent archive
//! update that stages, installs and activates a new Agent version.

mod agent;
mod channel;
mod error;
mod manifest;
mod progress;
mod source;
pub use progress::{UpdateProgress, UpdateProgressSink};
mod stage;
mod status;
mod version;

pub use agent::{AgentArchiveUpdateService, AgentUpdateRequest, KEEP_VERSIONS};
pub(crate) use error::UpdateCode;
pub use error::UpdateError;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
pub use version::version_newer;

use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use manifest::{AppArtifact, load_artifact};

const DEFAULT_MANIFEST: &str =
    "https://github.com/Hexpy-Games/butler/releases/latest/download/app-update-manifest.json";

#[derive(Clone, Default)]
pub struct UpdateRequest {
    pub component: Option<String>,
    pub components: Option<Vec<String>>,
    pub channel: Option<String>,
    pub manifest: Option<String>,
    pub dry_run: bool,
}

#[derive(Clone)]
pub struct AppUpdateService {
    data: PathBuf,
    installation: PathBuf,
    version: Option<String>,
    manifest: String,
    /// Downloads packages.
    client: reqwest::Client,
    /// Fetches the manifest: a short connect timeout and a small total, so a
    /// dead network fails the check quickly.
    manifest_client: reqwest::Client,
    writes: Arc<Mutex<()>>,
    checks: Arc<Mutex<()>>,
    shutdown: CancellationToken,
    /// Whether a background check is running.
    refreshing: Arc<AtomicBool>,
    pub progress: UpdateProgress,
}

/// Connecting to the manifest host.
const MANIFEST_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A whole manifest fetch.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(15);

impl AppUpdateService {
    pub fn new(
        data: PathBuf,
        installation: PathBuf,
        version: Option<String>,
    ) -> Result<Self, UpdateError> {
        if data.starts_with(&installation) || installation.starts_with(&data) {
            return Err(UpdateCode::ButlerDataOverlapsInstallation.into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(source::redirect_policy())
            .build()
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateHttpUnavailable, source))?;
        let manifest_client = reqwest::Client::builder()
            .user_agent("Butler updater")
            .connect_timeout(MANIFEST_CONNECT_TIMEOUT)
            .timeout(MANIFEST_TIMEOUT)
            .redirect(source::redirect_policy())
            .build()
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateHttpUnavailable, source))?;
        let manifest = std::env::var("BUTLER_APP_UPDATE_MANIFEST")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("BUTLER_UPDATE_MANIFEST")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_else(|| DEFAULT_MANIFEST.into());
        Ok(Self {
            data,
            installation,
            version,
            manifest,
            client,
            manifest_client,
            writes: Arc::new(Mutex::new(())),
            checks: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
            refreshing: Arc::new(AtomicBool::new(false)),
            progress: UpdateProgress::default(),
        })
    }

    pub fn close(&self) {
        self.shutdown.cancel();
    }

    pub async fn check(&self, request: UpdateRequest) -> Result<Value, UpdateError> {
        let _check = self.checks.lock().await;
        self.check_now(self.resolved_request(request).await).await
    }

    async fn check_now(&self, request: UpdateRequest) -> Result<Value, UpdateError> {
        validate_request(&request)?;
        let artifact = self.artifact(&request).await?;
        let status = self.status(&request, &artifact, "ok", None).await?;
        let view = self.persist_status(&request, status).await?;
        Ok(view)
    }

    pub async fn apply(&self, request: UpdateRequest) -> Result<Value, UpdateError> {
        let _check = self.checks.lock().await;
        let prior = self.progress.snapshot().await;
        if matches!(
            prior["stage"].as_str(),
            Some("ready" | "applying" | "restarting")
        ) {
            return Err(UpdateCode::InstallBusy.into());
        }
        let cancel = self.shutdown.child_token();
        self.progress.begin(cancel.clone()).await?;
        let result = self.apply_now(request, &cancel).await;
        match &result {
            Err(error) => {
                self.progress
                    .report("failed", None, None, Some(error.code()))
                    .await?;
            }
            Ok(status) => {
                self.progress
                    .report(
                        if status["stage_status"] == "staged" {
                            "ready"
                        } else {
                            "completed"
                        },
                        None,
                        None,
                        None,
                    )
                    .await?;
            }
        }
        result
    }

    async fn apply_now(
        &self,
        request: UpdateRequest,
        cancel: &CancellationToken,
    ) -> Result<Value, UpdateError> {
        let request = self.resolved_request(request).await;
        validate_request(&request)?;
        let artifact = self.artifact(&request).await?;
        let status = self.status(&request, &artifact, "ok", None).await?;
        let view = self.persist_status(&request, status).await?;
        let mut status = view["components"][0].clone();
        let actions = if status["update_available"] == true {
            vec![
                "download Butler App package",
                "verify package sha256",
                "stage package under BUTLER_DATA updates",
                "user installs the App package",
            ]
        } else {
            vec!["Butler App is already up to date"]
        };
        let mut artifact_path = None;
        if !request.dry_run && status["update_available"] == true {
            artifact_path = Some(
                Box::pin(stage::download(
                    &self.client,
                    cancel,
                    &self.data,
                    &self.installation,
                    &artifact,
                    Some(&self.progress),
                ))
                .await?,
            );
        }
        let stage_status = if request.dry_run {
            "dry_run"
        } else if artifact_path.is_some() {
            "staged"
        } else {
            "up_to_date"
        };
        let object = status
            .as_object_mut()
            .ok_or(UpdateCode::UpdateStatusInvalid)?;
        object.insert("staged".into(), json!(!request.dry_run));
        object.insert("stage_status".into(), json!(stage_status));
        object.insert("activation_status".into(), json!("not_required"));
        object.insert("dry_run".into(), json!(request.dry_run));
        object.insert("dryRun".into(), json!(request.dry_run));
        object.insert("artifact_path".into(), json!(artifact_path));
        object.insert("planned_actions".into(), json!(actions));
        if !request.dry_run {
            let _write = self.writes.lock().await;
            stage::write_json(
                &self.data,
                &self.installation,
                "updates/staged/app.json",
                &status,
            )
            .await?;
        }
        Ok(status)
    }

    async fn persist_status(
        &self,
        request: &UpdateRequest,
        status: Value,
    ) -> Result<Value, UpdateError> {
        let mut view = self.view(request, &status);
        view["receive_previews"] =
            json!(channel::previews(&self.data, request.channel.as_deref()).await);
        let _write = self.writes.lock().await;
        stage::write_json(&self.data, &self.installation, status::STATUS_LABEL, &view).await?;
        Ok(view)
    }

    /// The `UpdateStatusView` around one component status.
    fn view(&self, request: &UpdateRequest, status: &Value) -> Value {
        json!({
            "generated_at": status["checked_at"],
            "components": [status],
            "storage_label": "updates",
            "manifest_source": manifest::public_source(request.manifest.as_deref().unwrap_or(&self.manifest)),
            "raw_text_included": false,
        })
    }

    async fn status(
        &self,
        request: &UpdateRequest,
        artifact: &AppArtifact,
        check_state: &str,
        check_error: Option<&str>,
    ) -> Result<Value, UpdateError> {
        let current = self
            .version
            .as_deref()
            .ok_or(UpdateCode::AppVersionUnavailable)?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let prior =
            stage::read_json(&self.data, &self.installation, "updates/staged/app.json").await;
        let update_available = version_newer(&artifact.version, current);
        Ok(json!({
            "component": "app",
            "current_version": current,
            "available_version": artifact.version,
            "update_available": update_available,
            "channel": artifact.channel,
            "platform": artifact.platform,
            "artifact_url": artifact.url.as_deref().map(manifest::public_source),
            "sha256": artifact.sha256,
            "signature": null,
            "bundled_components": ["app"],
            "bundled_agent_version": artifact.bundled_agent_version,
            "product": "butler-app",
            "canonical_component": "app",
            "profile": "electron",
            "protocol_compatibility": artifact.protocol_compatibility,
            "integrity": {"digestAlgorithm":"sha256", "digest":artifact.sha256,"signature":null},
            "update_policy": "app-user-action",
            "restart_policy": "restart-app",
            "updater_owner": "butler-app",
            "payload_format": "platform-app-package",
            "staging_policy": "butler-data-updates",
            "activation_policy": "user-installs-app-package",
            "rollback_policy": "not-managed-by-butler",
            "checked_at": now,
            "check_state": check_state,
            "check_error": check_error,
            "staged": prior.is_some(),
            "stage_path": "updates/staged/app.json",
            "stage_status": prior.as_ref().and_then(|value| value.get("stage_status")).unwrap_or(&json!("up_to_date")),
            "activation_status": "not_required",
            "active_runtime_path": null,
            "attempted_runtime_path": null,
            "previous_runtime_path": null,
            "rollback_reason": null,
            "manifest_source": manifest::public_source(request.manifest.as_deref().unwrap_or(&self.manifest)),
        }))
    }

    async fn artifact(&self, request: &UpdateRequest) -> Result<AppArtifact, UpdateError> {
        if self.version.is_none() {
            return Err(UpdateCode::AppVersionUnavailable.into());
        }
        let previews = channel::previews(&self.data, request.channel.as_deref()).await;
        let source = channel::source(
            &self.manifest_client,
            &self.shutdown,
            request.manifest.as_deref().unwrap_or(&self.manifest),
            previews,
        )
        .await?;
        load_artifact(
            &self.manifest_client,
            &self.shutdown,
            &source,
            Some(if previews { "preview" } else { "stable" }),
        )
        .await
    }
}

fn validate_request(request: &UpdateRequest) -> Result<(), UpdateError> {
    if request
        .component
        .as_deref()
        .is_some_and(|value| value != "app")
        || request
            .components
            .as_ref()
            .is_some_and(|values| values.iter().any(|value| value != "app"))
    {
        return Err(UpdateCode::UnsupportedComponent.into());
    }
    Ok(())
}
