//! The standalone Agent projection of the source update-manifest contract.

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{MAX_MANIFEST_BYTES, read_manifest};

const AGENT_PLATFORM: &str = "darwin-arm64";

pub(crate) struct AgentArtifact {
    pub(crate) version: String,
    pub(crate) channel: String,
    pub(crate) platform: String,
    pub(crate) url: Option<String>,
    pub(crate) sha256: Option<String>,
}

pub(crate) async fn load_agent_artifact(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    source: &str,
    channel: Option<&str>,
) -> Result<AgentArtifact, String> {
    let resolved_source = if source.starts_with("http://")
        || source.starts_with("https://")
        || source.starts_with("file://")
        || std::path::Path::new(source).is_absolute()
    {
        source.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| "update_manifest_source_invalid")?
            .join(source)
            .to_string_lossy()
            .into_owned()
    };
    let bytes = read_manifest(client, shutdown, &resolved_source).await?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("update_manifest_too_large".into());
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| "update_manifest_invalid")?;
    let artifacts = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| {
            manifest
                .get("components")
                .and_then(Value::as_array)
                .map(|components| components.iter().map(component_as_artifact).collect())
        })
        .filter(|artifacts: &Vec<Value>| !artifacts.is_empty())
        .ok_or("update_manifest_artifacts_missing")?;
    let mut candidates = Vec::new();
    for artifact in &artifacts {
        let component = artifact
            .get("component")
            .or_else(|| artifact.get("id"))
            .and_then(Value::as_str)
            .ok_or("update_manifest_component_invalid")?;
        if !matches!(component, "service" | "agent" | "butler-agent") {
            if !matches!(component, "app" | "butler-app" | "app-server") {
                return Err("update_manifest_component_invalid".into());
            }
            continue;
        }
        candidates.push(artifact);
    }
    let selected = candidates
        .iter()
        .copied()
        .find(|artifact| string(artifact, "platform") == Some(AGENT_PLATFORM))
        .or_else(|| {
            candidates
                .iter()
                .copied()
                .find(|artifact| string(artifact, "platform") == Some("all"))
        })
        .or_else(|| {
            candidates
                .iter()
                .copied()
                .find(|artifact| string(artifact, "platform").is_none())
        })
        .ok_or("update_manifest_agent_platform_missing")?;
    validate_source_contract(selected)?;
    let version = required(selected, "version")?;
    let actual_channel = string(selected, "channel").or(channel).unwrap_or("stable");
    let platform = string(selected, "platform").unwrap_or("all");
    if platform != "all" && platform != AGENT_PLATFORM {
        return Err("update_manifest_agent_platform_missing".into());
    }
    let url = string_any(selected, &["artifact_url", "downloadUrl", "url"]);
    let sha256 = string(selected, "sha256").map(str::to_ascii_lowercase);
    if sha256
        .as_deref()
        .is_some_and(|digest| !valid_sha256(digest))
    {
        return Err("update_manifest_sha256_invalid".into());
    }
    if let Some(integrity) = selected.get("integrity") {
        if string(integrity, "digestAlgorithm") != Some("sha256") {
            return Err("update_manifest_incompatible".into());
        }
        if string(integrity, "signature").is_some() {
            return Err("update_signature_unsupported".into());
        }
        if string(integrity, "digest").is_some_and(|digest| {
            sha256
                .as_deref()
                .is_none_or(|sha| !digest.eq_ignore_ascii_case(sha))
        }) {
            return Err("update_manifest_incompatible".into());
        }
    }
    if string(selected, "signature").is_some() {
        return Err("update_signature_unsupported".into());
    }
    Ok(AgentArtifact {
        version: version.into(),
        channel: actual_channel.into(),
        platform: platform.into(),
        url: url.map(str::to_owned),
        sha256,
    })
}

fn component_as_artifact(component: &Value) -> Value {
    let mut artifact = component.clone();
    if let Some(object) = artifact.as_object_mut() {
        let component_id = object
            .get("id")
            .or_else(|| object.get("component"))
            .and_then(Value::as_str)
            .unwrap_or("service")
            .to_owned();
        object.insert("component".into(), Value::String(component_id.clone()));
        object
            .entry("bundled_components")
            .or_insert_with(|| serde_json::json!([component_id]));
        for (snake, camel) in [
            ("artifact_url", "downloadUrl"),
            ("artifact_url", "url"),
            ("canonical_component", "canonicalComponent"),
            ("protocol_compatibility", "protocolCompatibility"),
            ("update_policy", "updatePolicy"),
            ("restart_policy", "restartPolicy"),
            ("updater_owner", "updaterOwner"),
            ("payload_format", "payloadFormat"),
            ("staging_policy", "stagingPolicy"),
            ("activation_policy", "activationPolicy"),
            ("rollback_policy", "rollbackPolicy"),
        ] {
            if !object.contains_key(snake)
                && let Some(value) = object.get(camel).cloned()
            {
                object.insert(snake.into(), value);
            }
        }
    }
    artifact
}

fn validate_source_contract(artifact: &Value) -> Result<(), String> {
    for (field, expected) in [
        ("product", "butler-agent"),
        ("canonical_component", "agent"),
        ("profile", "agent-standalone"),
        ("update_policy", "explicit"),
        ("restart_policy", "restart-service"),
        ("updater_owner", "butler-agent"),
        ("payload_format", "agent-archive"),
        ("staging_policy", "butler-data-updates"),
        ("activation_policy", "user-installs-standalone-archive"),
        ("rollback_policy", "not-managed-by-butler"),
    ] {
        if string(artifact, field) != Some(expected) {
            return Err("update_manifest_incompatible".into());
        }
    }
    if let Some(bundled) = artifact
        .get("bundled_components")
        .or_else(|| artifact.get("bundledComponents"))
    {
        let valid = bundled.as_array().is_some_and(|items| {
            items.len() == 1
                && items[0]
                    .as_str()
                    .is_some_and(|value| matches!(value, "service" | "agent" | "butler-agent"))
        });
        if !valid {
            return Err("update_manifest_incompatible".into());
        }
    }
    if let Some(protocol) = artifact
        .get("protocol_compatibility")
        .or_else(|| artifact.get("protocolCompatibility"))
    {
        for field in ["protocol", "minimumAgentProtocol", "maximumAgentProtocol"] {
            if protocol.get(field).and_then(Value::as_str) != Some("butler.agent.v1") {
                return Err("update_manifest_incompatible".into());
            }
        }
    }
    Ok(())
}

fn required<'a>(artifact: &'a Value, field: &str) -> Result<&'a str, String> {
    string(artifact, field)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("update_manifest_{field}_missing"))
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn string_any<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| string(value, key))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{component_as_artifact, validate_source_contract};

    #[test]
    fn accepts_the_source_agent_archive_contract_and_aliases() {
        let artifact = component_as_artifact(&json!({
            "id": "agent",
            "version": "2.4.0",
            "downloadUrl": "https://example.invalid/agent.tar.gz",
            "product": "butler-agent",
            "canonicalComponent": "agent",
            "profile": "agent-standalone",
            "updatePolicy": "explicit",
            "restartPolicy": "restart-service",
            "updaterOwner": "butler-agent",
            "payloadFormat": "agent-archive",
            "stagingPolicy": "butler-data-updates",
            "activationPolicy": "user-installs-standalone-archive",
            "rollbackPolicy": "not-managed-by-butler"
        }));
        validate_source_contract(&artifact).expect("source manifest fields are accepted");
        assert_eq!(artifact["component"], "agent");
        assert_eq!(
            artifact["artifact_url"],
            "https://example.invalid/agent.tar.gz"
        );
    }

    #[test]
    fn rejects_an_archive_that_bundles_app_components() {
        let artifact = json!({"bundled_components": ["service", "app"]});
        assert_eq!(
            validate_source_contract(&artifact).unwrap_err(),
            "update_manifest_incompatible"
        );
    }
}
