//! Verified Agent archive handoff; never activates or replaces the running install.

use std::{path::PathBuf, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::{manifest, stage};

const DEFAULT_MANIFEST: &str =
    "https://github.com/Hexpy-Games/butler/releases/latest/download/agent-update-manifest.json";

#[derive(Clone, Default)]
pub(crate) struct AgentUpdateRequest {
    pub manifest: Option<String>,
    pub channel: Option<String>,
    pub dry_run: bool,
}

#[derive(Clone)]
pub(crate) struct AgentArchiveUpdateService {
    data: PathBuf,
    installation: PathBuf,
    current_version: Option<String>,
    manifest: String,
    client: reqwest::Client,
    writes: Arc<Mutex<()>>,
    shutdown: CancellationToken,
}

impl AgentArchiveUpdateService {
    pub(crate) fn new(
        data: PathBuf,
        installation: PathBuf,
        current_version: Option<String>,
    ) -> Result<Self, String> {
        if data.starts_with(&installation) || installation.starts_with(&data) {
            return Err("butler_data_overlaps_installation".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "update_http_unavailable")?;
        let manifest = std::env::var("BUTLER_UPDATE_MANIFEST")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MANIFEST.into());
        Ok(Self {
            data,
            installation,
            current_version,
            manifest,
            client,
            writes: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
        })
    }

    pub(crate) fn close(&self) {
        self.shutdown.cancel();
    }

    pub(crate) fn cancellation_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub(crate) async fn check(&self, request: &AgentUpdateRequest) -> Result<Value, String> {
        let (status, _) = self.status(request).await?;
        self.persist_status(request, &status).await?;
        Ok(status)
    }

    pub(crate) async fn apply(&self, request: &AgentUpdateRequest) -> Result<Value, String> {
        let (mut status, download_url) = self.status(request).await?;
        self.persist_status(request, &status).await?;
        let available = status["update_available"] == true;
        let mut artifact_path = None;
        if available && !request.dry_run {
            let url = download_url
                .as_deref()
                .ok_or("update_artifact_url_missing")?;
            let sha256 = status["sha256"]
                .as_str()
                .ok_or("update_artifact_sha256_missing")?;
            let name = artifact_name(
                url,
                status["available_version"].as_str().unwrap_or("unknown"),
            );
            let label = format!("updates/artifacts/{name}");
            artifact_path = Some(
                Box::pin(stage::download_to_label(
                    &self.client,
                    &self.shutdown,
                    &self.data,
                    &self.installation,
                    url,
                    sha256,
                    &label,
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
        let archive_staged = artifact_path.is_some();
        let actions = if available {
            vec![
                "download Butler Agent archive",
                "verify archive sha256",
                "stage archive under BUTLER_DATA updates",
                "user installs the standalone archive",
                "user restarts Butler Agent to apply it",
            ]
        } else {
            vec!["Butler Agent is already up to date"]
        };
        let object = status.as_object_mut().ok_or("update_status_invalid")?;
        object.insert("staged".into(), json!(archive_staged));
        object.insert("dry_run".into(), json!(request.dry_run));
        object.insert("dryRun".into(), json!(request.dry_run));
        object.insert("artifact_path".into(), json!(artifact_path));
        object.insert("planned_actions".into(), json!(actions));
        object.insert("stage_status".into(), json!(stage_status));
        object.insert(
            "activation_status".into(),
            json!(if archive_staged {
                "pending_user_install"
            } else {
                "not_required"
            }),
        );
        object.insert(
            "activation_policy".into(),
            json!("user-installs-standalone-archive"),
        );
        object.insert("rollback_policy".into(), json!("not-managed-by-butler"));
        if !request.dry_run {
            if self.shutdown.is_cancelled() {
                return Err("update_cancelled".into());
            }
            let _write = self.writes.lock().await;
            if self.shutdown.is_cancelled() {
                return Err("update_cancelled".into());
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

    async fn persist_status(
        &self,
        request: &AgentUpdateRequest,
        status: &Value,
    ) -> Result<(), String> {
        if self.shutdown.is_cancelled() {
            return Err("update_cancelled".into());
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
            return Err("update_cancelled".into());
        }
        stage::write_json(&self.data, &self.installation, "updates/status.json", &view).await
    }

    async fn status(
        &self,
        request: &AgentUpdateRequest,
    ) -> Result<(Value, Option<String>), String> {
        let current = self
            .current_version
            .as_deref()
            .filter(|version| !version.trim().is_empty())
            .ok_or("agent_version_unavailable")?;
        let source = request.manifest.as_deref().unwrap_or(&self.manifest);
        let artifact = manifest::load_agent_artifact(
            &self.client,
            &self.shutdown,
            source,
            request.channel.as_deref(),
        )
        .await?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
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
        let prior_staged = if prior_record_matches {
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
        };
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
                "activation_policy": "user-installs-standalone-archive",
                "rollback_policy": "not-managed-by-butler",
                "checked_at": now,
                "staged": prior_staged,
                "stage_path": "updates/staged/service.json",
                "stage_status": if prior_staged { "staged" } else { "up_to_date" },
                "activation_status": if prior_staged { "pending_user_install" } else { "not_required" },
                "active_runtime_path": null,
                "attempted_runtime_path": null,
                "previous_runtime_path": null,
                "rollback_reason": null,
                "manifest_source": manifest::public_source(source),
            }),
            url,
        ))
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

fn version_newer(available: &str, current: &str) -> bool {
    let parse = |version: &str| {
        version
            .split(['.', '-'])
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>()
    };
    let available = parse(available);
    let current = parse(current);
    (0..available.len().max(current.len()).max(3))
        .map(|index| {
            (
                available.get(index).copied().unwrap_or(0),
                current.get(index).copied().unwrap_or(0),
            )
        })
        .find(|(left, right)| left != right)
        .is_some_and(|(left, right)| left > right)
}

#[cfg(test)]
mod tests {
    use super::version_newer;

    #[test]
    fn compares_source_version_segments() {
        assert!(version_newer("1.2.1", "1.2.0"));
        assert!(!version_newer("1.2.0", "1.2.0"));
        assert!(!version_newer("1.1.9", "1.2.0"));
    }
}
