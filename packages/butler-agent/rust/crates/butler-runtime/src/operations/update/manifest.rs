use std::path::Path;

use crate::operations::update::{UpdateCode, UpdateError};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

mod agent;
pub(super) use agent::{ACTIVATION_POLICY, ROLLBACK_POLICY, load_agent_artifact};

pub(super) struct AppArtifact {
    pub version: String,
    pub channel: String,
    pub platform: String,
    pub url: Option<String>,
    pub sha256: Option<String>,
    pub bundled_agent_version: Option<String>,
    pub protocol_compatibility: Value,
}

pub(super) async fn load_artifact(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    source: &str,
    channel: Option<&str>,
) -> Result<AppArtifact, UpdateError> {
    let body = read_manifest(client, shutdown, source).await?;
    let manifest: Value = serde_json::from_slice(&body)
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateManifestInvalid, source))?;
    let array = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or(UpdateCode::UpdateManifestArtifactsMissing)?;
    let platform = butler_platform::launcher::release_platform();
    let app: Vec<&Value> = array
        .iter()
        .filter(|value| value.get("component").and_then(Value::as_str) == Some("app"))
        .collect();
    let selected = app
        .iter()
        .copied()
        .find(|value| value.get("platform").and_then(Value::as_str) == Some(platform.as_str()))
        .or_else(|| {
            app.iter()
                .copied()
                .find(|value| value.get("platform").is_none())
        })
        .ok_or(UpdateCode::UpdateManifestAppPlatformMissing)?;
    for (field, expected) in [
        ("product", "butler-app"),
        ("canonical_component", "app"),
        ("profile", "electron"),
        ("update_policy", "app-user-action"),
        ("restart_policy", "restart-app"),
        ("updater_owner", "butler-app"),
        ("payload_format", "platform-app-package"),
        ("staging_policy", "butler-data-updates"),
        ("activation_policy", "user-installs-app-package"),
        ("rollback_policy", "not-managed-by-butler"),
    ] {
        if selected
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| value != expected)
        {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
        if matches!(
            field,
            "staging_policy" | "activation_policy" | "rollback_policy"
        ) && selected.get(field).and_then(Value::as_str) != Some(expected)
        {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
    }
    if selected
        .get("bundled_components")
        .is_some_and(|value| value != &json!(["app"]))
    {
        return Err(UpdateCode::UpdateManifestIncompatible.into());
    }
    let signature = selected
        .get("signature")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            selected
                .pointer("/integrity/signature")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
    if signature.is_some() {
        return Err(UpdateCode::UpdateSignatureUnsupported.into());
    }
    if selected
        .get("integrity")
        .is_some_and(|value| value.get("digestAlgorithm").and_then(Value::as_str) != Some("sha256"))
    {
        return Err(UpdateCode::UpdateManifestIncompatible.into());
    }
    let version = required_version(selected)?;
    let url = selected
        .get("artifact_url")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let sha256 = selected
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_ascii_lowercase);
    if sha256.as_deref().is_some_and(|digest| {
        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(UpdateCode::UpdateManifestSha256Invalid.into());
    }
    if selected
        .pointer("/integrity/digest")
        .and_then(Value::as_str)
        .is_some_and(|digest| {
            sha256
                .as_deref()
                .is_none_or(|sha| !digest.eq_ignore_ascii_case(sha))
        })
    {
        return Err(UpdateCode::UpdateManifestIncompatible.into());
    }
    let protocol = selected.get("protocol_compatibility").cloned().unwrap_or_else(|| json!({
        "protocol":"butler.app.v1", "minimumAppProtocol":"butler.app.v1", "maximumAppProtocol":"butler.app.v1"
    }));
    for field in ["protocol", "minimumAppProtocol", "maximumAppProtocol"] {
        if protocol.get(field).and_then(Value::as_str) != Some("butler.app.v1") {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
    }
    Ok(AppArtifact {
        version: version.into(),
        channel: selected
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or(channel.unwrap_or("stable"))
            .into(),
        platform: selected
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or(&platform)
            .into(),
        url,
        sha256,
        bundled_agent_version: selected
            .get("bundled_agent_version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        protocol_compatibility: protocol,
    })
}

/// The manifest's required, non-blank `version`.
fn required_version(value: &Value) -> Result<&str, UpdateError> {
    let field = "version";
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .ok_or(UpdateCode::UpdateManifestVersionMissing.into())
}

async fn read_manifest(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    source: &str,
) -> Result<Vec<u8>, UpdateError> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let response = tokio::select! {
            () = shutdown.cancelled() => return Err(UpdateCode::UpdateCancelled.into()),
            result = client.get(source).send() => result.map_err(|source| UpdateError::caused(UpdateCode::UpdateManifestUnavailable, source))?,
        };
        if !response.status().is_success() {
            return Err(UpdateCode::UpdateManifestUnavailable.into());
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = tokio::select! {
            () = shutdown.cancelled() => return Err(UpdateCode::UpdateCancelled.into()),
            chunk = stream.next() => chunk,
        } {
            let chunk = chunk.map_err(|source| {
                UpdateError::caused(UpdateCode::UpdateManifestUnavailable, source)
            })?;
            if body.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
                return Err(UpdateCode::UpdateManifestTooLarge.into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(body);
    }
    let path = if source.starts_with("file://") {
        url::Url::parse(source)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or(UpdateCode::UpdateManifestSourceInvalid)?
    } else {
        Path::new(source).to_path_buf()
    };
    if !path.is_absolute() {
        return Err(UpdateCode::UpdateManifestSourceInvalid.into());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateManifestUnavailable, source))?;
    if metadata.len() > MAX_MANIFEST_BYTES as u64 {
        return Err(UpdateCode::UpdateManifestTooLarge.into());
    }
    tokio::fs::read(path)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateManifestUnavailable, source))
}

pub(super) fn public_source(source: &str) -> String {
    if let Ok(mut url) = url::Url::parse(source)
        && matches!(url.scheme(), "http" | "https")
    {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return url.to_string();
    }
    "local-file".into()
}
