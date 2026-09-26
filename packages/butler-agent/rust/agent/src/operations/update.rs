//! App-package update checks and DATA-only staging. Installation stays immutable.

mod agent;
mod manifest;
mod stage;

pub(crate) use agent::{AgentArchiveUpdateService, AgentUpdateRequest};

use std::{path::PathBuf, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use manifest::{AppArtifact, load_artifact};

const DEFAULT_MANIFEST: &str =
    "https://github.com/Hexpy-Games/butler/releases/latest/download/app-update-manifest.json";

#[derive(Clone, Default)]
pub(crate) struct UpdateRequest {
    pub component: Option<String>,
    pub components: Option<Vec<String>>,
    pub channel: Option<String>,
    pub manifest: Option<String>,
    pub dry_run: bool,
}

#[derive(Clone)]
pub(crate) struct AppUpdateService {
    data: PathBuf,
    installation: PathBuf,
    version: Option<String>,
    manifest: String,
    client: reqwest::Client,
    writes: Arc<Mutex<()>>,
    shutdown: CancellationToken,
}

impl AppUpdateService {
    pub(crate) fn new(
        data: PathBuf,
        installation: PathBuf,
        version: Option<String>,
    ) -> Result<Self, String> {
        if data.starts_with(&installation) || installation.starts_with(&data) {
            return Err("butler_data_overlaps_installation".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "update_http_unavailable")?;
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
            writes: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
        })
    }

    pub(crate) fn close(&self) {
        self.shutdown.cancel();
    }

    pub(crate) async fn check(&self, request: UpdateRequest) -> Result<Value, String> {
        validate_request(&request)?;
        let artifact = self.artifact(&request).await?;
        let status = self.status(&request, &artifact).await?;
        let view = self.persist_status(&request, status).await?;
        Ok(view)
    }

    pub(crate) async fn apply(&self, request: UpdateRequest) -> Result<Value, String> {
        validate_request(&request)?;
        let artifact = self.artifact(&request).await?;
        let status = self.status(&request, &artifact).await?;
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
                stage::download(
                    &self.client,
                    &self.shutdown,
                    &self.data,
                    &self.installation,
                    &artifact,
                )
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
        let object = status.as_object_mut().ok_or("update_status_invalid")?;
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
    ) -> Result<Value, String> {
        let view = json!({
            "generated_at": status["checked_at"],
            "components": [status],
            "storage_label": "updates",
            "manifest_source": manifest::public_source(request.manifest.as_deref().unwrap_or(&self.manifest)),
            "raw_text_included": false,
        });
        let _write = self.writes.lock().await;
        stage::write_json(&self.data, &self.installation, "updates/status.json", &view).await?;
        Ok(view)
    }

    async fn status(
        &self,
        request: &UpdateRequest,
        artifact: &AppArtifact,
    ) -> Result<Value, String> {
        let current = self.version.as_deref().ok_or("app_version_unavailable")?;
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

    async fn artifact(&self, request: &UpdateRequest) -> Result<AppArtifact, String> {
        if self.version.is_none() {
            return Err("app_version_unavailable".into());
        }
        let source = request.manifest.as_deref().unwrap_or(&self.manifest);
        load_artifact(
            &self.client,
            &self.shutdown,
            source,
            request.channel.as_deref(),
        )
        .await
    }
}

fn validate_request(request: &UpdateRequest) -> Result<(), String> {
    if request
        .component
        .as_deref()
        .is_some_and(|value| value != "app")
        || request
            .components
            .as_ref()
            .is_some_and(|values| values.iter().any(|value| value != "app"))
    {
        return Err("unsupported_component".into());
    }
    Ok(())
}

fn version_newer(available: &str, current: &str) -> bool {
    let parse = |version: &str| -> Vec<u64> {
        version
            .split(['.', '-'])
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let left = parse(available);
    let right = parse(current);
    (0..left.len().max(right.len()).max(3))
        .map(|index| {
            (
                left.get(index).copied().unwrap_or(0),
                right.get(index).copied().unwrap_or(0),
            )
        })
        .find(|(left, right)| left != right)
        .is_some_and(|(left, right)| left > right)
}
