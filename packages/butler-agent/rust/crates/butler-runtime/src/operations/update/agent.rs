//! Agent archive update: download and verify the archive for this platform,
//! install it as a version of the Agent home and switch `current` to it.
//! Restarting the service on the new version is the caller's step: it needs
//! the new executable, which only the CLI can start.

use crate::operations::install::AgentHome;
use crate::operations::update::{UpdateCode, UpdateError};
use std::{path::PathBuf, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::source::{redirect_allowed, secure_source};
use super::version::version_newer;
use super::{manifest, stage};

const DEFAULT_MANIFEST: &str =
    "https://github.com/Hexpy-Games/butler/releases/latest/download/agent-update-manifest.json";

/// Installed versions kept after an update, besides the active and previous
/// ones and any a running service uses.
pub const KEEP_VERSIONS: usize = 3;

#[derive(Clone, Default)]
pub struct AgentUpdateRequest {
    pub manifest: Option<String>,
    pub channel: Option<String>,
    pub dry_run: bool,
    /// Executables in use (the running service's): their versions are never
    /// pruned.
    pub protected: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct AgentArchiveUpdateService {
    data: PathBuf,
    installation: PathBuf,
    current_version: Option<String>,
    home: Option<AgentHome>,
    manifest: String,
    client: reqwest::Client,
    writes: Arc<Mutex<()>>,
    shutdown: CancellationToken,
}

impl AgentArchiveUpdateService {
    pub fn new(
        data: PathBuf,
        installation: PathBuf,
        current_version: Option<String>,
    ) -> Result<Self, UpdateError> {
        if data.starts_with(&installation) || installation.starts_with(&data) {
            return Err(UpdateCode::ButlerDataOverlapsInstallation.into());
        }
        let client = reqwest::Client::builder()
            // A slow download is fine, a stalled one is not: no limit on the
            // whole request, a limit on connecting and on each read.
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if redirect_allowed(attempt.previous(), attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateHttpUnavailable, source))?;
        let manifest = std::env::var("BUTLER_UPDATE_MANIFEST")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MANIFEST.into());
        Ok(Self {
            data,
            installation,
            current_version,
            home: None,
            manifest,
            client,
            writes: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
        })
    }

    /// Installs and activates downloaded archives in `home`; without it the
    /// service only checks and stages.
    #[must_use]
    pub fn with_home(mut self, home: AgentHome) -> Self {
        self.home = Some(home);
        self
    }

    pub fn close(&self) {
        self.shutdown.cancel();
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn check(&self, request: &AgentUpdateRequest) -> Result<Value, UpdateError> {
        let (status, _) = self.status(request).await?;
        self.persist_status(request, &status).await?;
        Ok(status)
    }

    pub async fn apply(&self, request: &AgentUpdateRequest) -> Result<Value, UpdateError> {
        let (mut status, download_url) = self.status(request).await?;
        self.persist_status(request, &status).await?;
        let available = status["update_available"] == true;
        let staged = if available && !request.dry_run {
            Some(self.stage_archive(&status, download_url.as_deref()).await?)
        } else {
            None
        };
        let installed = match (&staged, &self.home) {
            (Some(label), Some(home)) => {
                let installed = self
                    .install_staged(home, label, &status, &request.protected)
                    .await;
                // Installed or not, the download is not kept under DATA.
                stage::remove_staged(&self.data, &self.installation, label).await;
                Some(installed?)
            }
            _ => None,
        };
        annotate(
            &mut status,
            &Outcome {
                dry_run: request.dry_run,
                available,
                staged,
                installed,
            },
        )?;
        if !request.dry_run {
            if self.shutdown.is_cancelled() {
                return Err(UpdateCode::UpdateCancelled.into());
            }
            let _write = self.writes.lock().await;
            if self.shutdown.is_cancelled() {
                return Err(UpdateCode::UpdateCancelled.into());
            }
            stage::write_json(
                &self.data,
                &self.installation,
                "updates/staged/service.json",
                &status,
            )
            .await?;
        }
        Ok(status)
    }

    /// Downloads the archive under DATA and returns its label.
    async fn stage_archive(
        &self,
        status: &Value,
        download_url: Option<&str>,
    ) -> Result<String, UpdateError> {
        let url = download_url.ok_or(UpdateCode::UpdateArtifactUrlMissing)?;
        if !secure_source(url) {
            return Err(UpdateCode::UpdateArtifactSourceInvalid.into());
        }
        let sha256 = status["sha256"]
            .as_str()
            .ok_or(UpdateCode::UpdateArtifactSha256Missing)?;
        let name = artifact_name(
            url,
            status["available_version"].as_str().unwrap_or("unknown"),
        );
        let label = format!("updates/artifacts/{name}");
        Box::pin(stage::download_to_label(
            &self.client,
            &self.shutdown,
            &self.data,
            &self.installation,
            url,
            sha256,
            &label,
        ))
        .await
    }

    /// Downloads an archive into `directory` (a scratch directory outside
    /// DATA that the caller removes), checking `sha256` before keeping it,
    /// and returns its path. Only `https` is fetched, and `http` from this
    /// machine (tests); a download larger than the archive cap is refused.
    /// For `butler install --from <url>`.
    ///
    /// # Errors
    ///
    /// The download and digest codes of the update flow, and
    /// `install_archive_too_large`.
    pub async fn fetch_archive(
        &self,
        source: &str,
        sha256: &str,
        directory: &std::path::Path,
    ) -> Result<PathBuf, UpdateError> {
        if !secure_source(source) {
            return Err(UpdateCode::UpdateArtifactSourceInvalid.into());
        }
        let label = "archive.tar.gz";
        Box::pin(stage::download_to_label(
            &self.client,
            &self.shutdown,
            directory,
            &self.installation,
            source,
            &sha256.to_ascii_lowercase(),
            label,
        ))
        .await?;
        Ok(directory.join(label))
    }

    /// Extracts the staged archive into the home and makes it the active
    /// version, then prunes old versions. The home's lock is held throughout.
    async fn install_staged(
        &self,
        home: &AgentHome,
        label: &str,
        status: &Value,
        protected: &[PathBuf],
    ) -> Result<Value, UpdateError> {
        if self.shutdown.is_cancelled() {
            return Err(UpdateCode::UpdateCancelled.into());
        }
        let sha256 = status["sha256"]
            .as_str()
            .ok_or(UpdateCode::UpdateArtifactSha256Missing)?
            .to_owned();
        let (home, archive, protected) = (home.clone(), self.data.join(label), protected.to_vec());
        tokio::task::spawn_blocking(move || {
            home.install_and_activate(&archive, Some(&sha256), KEEP_VERSIONS, &protected)
                .map(|activated| activated.to_json())
        })
        .await
        .map_err(|error| UpdateError::caused(UpdateCode::InstallWriteFailed, error))?
    }

    async fn persist_status(
        &self,
        request: &AgentUpdateRequest,
        status: &Value,
    ) -> Result<(), UpdateError> {
        if self.shutdown.is_cancelled() {
            return Err(UpdateCode::UpdateCancelled.into());
        }
        let view = json!({
            "schema": "butler.update-status.v1",
            "generated_at": status["checked_at"],
            "components": [status],
            "storage_label": "updates",
            "manifest_source": manifest::public_source(
                request.manifest.as_deref().unwrap_or(&self.manifest)
            ),
            "raw_text_included": false,
        });
        let _write = self.writes.lock().await;
        if self.shutdown.is_cancelled() {
            return Err(UpdateCode::UpdateCancelled.into());
        }
        stage::write_json(&self.data, &self.installation, "updates/status.json", &view).await
    }

    async fn status(
        &self,
        request: &AgentUpdateRequest,
    ) -> Result<(Value, Option<String>), UpdateError> {
        let current = self
            .current_version
            .as_deref()
            .filter(|version| !version.trim().is_empty())
            .ok_or(UpdateCode::AgentVersionUnavailable)?;
        let previews = super::channel::previews(&self.data, request.channel.as_deref()).await;
        let source = super::channel::source(
            &self.client,
            &self.shutdown,
            request.manifest.as_deref().unwrap_or(&self.manifest),
            previews,
        )
        .await?;
        let artifact = manifest::load_agent_artifact(
            &self.client,
            &self.shutdown,
            &source,
            Some(if previews { "preview" } else { "stable" }),
        )
        .await?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let prior_staged = self.prior_staged(&artifact).await;
        let url = artifact.url.clone();
        Ok((
            json!({
                "component": "service",
                "current_version": current,
                "available_version": artifact.version,
                "update_available": version_newer(&artifact.version, current),
                "channel": artifact.channel,
                "platform": artifact.platform,
                "artifact_url": artifact.url.as_deref().map(manifest::public_source),
                "sha256": artifact.sha256,
                "signature": null,
                "bundled_components": ["service"],
                "bundled_agent_version": null,
                "product": "butler-agent",
                "canonical_component": "agent",
                "profile": "agent-standalone",
                "protocol_compatibility": {
                    "protocol": "butler.agent.v1",
                    "minimumAgentProtocol": "butler.agent.v1",
                    "maximumAgentProtocol": "butler.agent.v1"
                },
                "integrity": {"digestAlgorithm":"sha256", "digest":artifact.sha256,"signature":null},
                "update_policy": "explicit",
                "restart_policy": "restart-service",
                "updater_owner": "butler-agent",
                "payload_format": "agent-archive",
                "staging_policy": "butler-data-updates",
                "activation_policy": manifest::ACTIVATION_POLICY,
                "rollback_policy": manifest::ROLLBACK_POLICY,
                "checked_at": now,
                "staged": prior_staged,
                "stage_path": "updates/staged/service.json",
                "stage_status": if prior_staged { "staged" } else { "up_to_date" },
                "activation_status": if prior_staged { "pending_activation" } else { "not_required" },
                "active_runtime_path": null,
                "attempted_runtime_path": null,
                "previous_runtime_path": null,
                "rollback_reason": null,
                "manifest_source": manifest::public_source(&source),
            }),
            url,
        ))
    }
    async fn prior_staged(&self, artifact: &manifest::AgentArtifact) -> bool {
        let prior = stage::read_json(
            &self.data,
            &self.installation,
            "updates/staged/service.json",
        )
        .await;
        let prior_record_matches = prior.as_ref().is_some_and(|value| {
            value["staged"] == true
                && value["available_version"] == artifact.version
                && value["sha256"].as_str() == artifact.sha256.as_deref()
        });
        if prior_record_matches {
            match prior
                .as_ref()
                .and_then(|value| value["artifact_path"].as_str())
            {
                Some(label) => {
                    stage::staged_file_exists(&self.data, &self.installation, label).await
                }
                None => false,
            }
        } else {
            false
        }
    }
}

fn artifact_name(url: &str, version: &str) -> String {
    let path = url::Url::parse(url)
        .ok()
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|| url.to_owned());
    std::path::Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("butler-agent-{}.archive", safe_version(version)))
}

fn safe_version(version: &str) -> String {
    version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

/// What one `apply` did, for the status it reports.
struct Outcome {
    dry_run: bool,
    available: bool,
    /// The staged archive's label.
    staged: Option<String>,
    /// The installed and activated version.
    installed: Option<Value>,
}

fn annotate(status: &mut Value, outcome: &Outcome) -> Result<(), UpdateError> {
    // A staged archive that was installed is gone; one still here waits for
    // activation.
    let pending = outcome
        .staged
        .as_ref()
        .filter(|_| outcome.installed.is_none());
    let stage_status = if outcome.dry_run {
        "dry_run"
    } else if outcome.installed.is_some() {
        "installed"
    } else if pending.is_some() {
        "staged"
    } else {
        "up_to_date"
    };
    let activation_status = match (&outcome.installed, pending) {
        (Some(_), _) => "activated",
        (None, Some(_)) => "pending_activation",
        (None, None) => "not_required",
    };
    let actions = if outcome.available {
        vec![
            "download Butler Agent archive",
            "verify archive sha256",
            "extract it into the Agent home as <version>-<sha8>",
            "switch current to the new version",
            "restart the service if it is running",
            "keep the previous version for rollback and prune older ones",
        ]
    } else {
        vec!["Butler Agent is already up to date"]
    };
    let object = status
        .as_object_mut()
        .ok_or(UpdateCode::UpdateStatusInvalid)?;
    object.insert("staged".into(), json!(pending.is_some()));
    object.insert("dry_run".into(), json!(outcome.dry_run));
    object.insert("dryRun".into(), json!(outcome.dry_run));
    object.insert("artifact_path".into(), json!(pending));
    object.insert("planned_actions".into(), json!(actions));
    object.insert("stage_status".into(), json!(stage_status));
    object.insert("activation_status".into(), json!(activation_status));
    object.insert("installed".into(), json!(outcome.installed));
    object.insert(
        "restart_required".into(),
        json!(outcome.installed.is_some()),
    );
    object.insert(
        "activation_policy".into(),
        json!(manifest::ACTIVATION_POLICY),
    );
    object.insert("rollback_policy".into(), json!(manifest::ROLLBACK_POLICY));
    Ok(())
}
