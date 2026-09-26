use std::path::Path;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

mod agent;
pub(super) use agent::load_agent_artifact;

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
) -> Result<AppArtifact, String> {
    let body = read_manifest(client, shutdown, source).await?;
    let manifest: Value = serde_json::from_slice(&body).map_err(|_| "update_manifest_invalid")?;
    let array = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or("update_manifest_artifacts_missing")?;
    let os = if std::env::consts::OS == "macos" {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let platform = format!("{os}-{arch}");
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
        .ok_or("update_manifest_app_platform_missing")?;
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
            return Err("update_manifest_incompatible".into());
        }
        if matches!(
            field,
            "staging_policy" | "activation_policy" | "rollback_policy"
        ) && selected.get(field).and_then(Value::as_str) != Some(expected)
        {
            return Err("update_manifest_incompatible".into());
        }
    }
    if selected
        .get("bundled_components")
        .is_some_and(|value| value != &json!(["app"]))
    {
        return Err("update_manifest_incompatible".into());
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
        return Err("update_signature_unsupported".into());
    }
    if selected
        .get("integrity")
        .is_some_and(|value| value.get("digestAlgorithm").and_then(Value::as_str) != Some("sha256"))
    {
        return Err("update_manifest_incompatible".into());
    }
    let version = required(selected, "version")?;
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
        return Err("update_manifest_sha256_invalid".into());
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
        return Err("update_manifest_incompatible".into());
    }
    let protocol = selected.get("protocol_compatibility").cloned().unwrap_or_else(|| json!({
        "protocol":"butler.app.v1", "minimumAppProtocol":"butler.app.v1", "maximumAppProtocol":"butler.app.v1"
    }));
    for field in ["protocol", "minimumAppProtocol", "maximumAppProtocol"] {
        if protocol.get(field).and_then(Value::as_str) != Some("butler.app.v1") {
            return Err("update_manifest_incompatible".into());
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

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| format!("update_manifest_{field}_missing"))
}

async fn read_manifest(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    source: &str,
) -> Result<Vec<u8>, String> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let response = tokio::select! {
            () = shutdown.cancelled() => return Err("update_cancelled".into()),
            result = client.get(source).send() => result.map_err(|_| "update_manifest_unavailable")?,
        };
        if !response.status().is_success() {
            return Err("update_manifest_unavailable".into());
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = tokio::select! {
            () = shutdown.cancelled() => return Err("update_cancelled".into()),
            chunk = stream.next() => chunk,
        } {
            let chunk = chunk.map_err(|_| "update_manifest_unavailable")?;
            if body.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
                return Err("update_manifest_too_large".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(body);
    }
    let path = if source.starts_with("file://") {
        url::Url::parse(source)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or("update_manifest_source_invalid")?
    } else {
        Path::new(source).to_path_buf()
    };
    if !path.is_absolute() {
        return Err("update_manifest_source_invalid".into());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "update_manifest_unavailable")?;
    if metadata.len() > MAX_MANIFEST_BYTES as u64 {
        return Err("update_manifest_too_large".into());
    }
    tokio::fs::read(path)
        .await
        .map_err(|_| "update_manifest_unavailable".into())
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
