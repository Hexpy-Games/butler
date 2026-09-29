//! The standalone Agent projection of the source update-manifest contract.

use crate::operations::update::{UpdateCode, UpdateError};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{MAX_MANIFEST_BYTES, read_manifest};

/// Butler extracts, activates and restarts the archive it downloads.
pub(crate) const ACTIVATION_POLICY: &str = "butler-managed";
/// Butler switches back to the previous version on request.
pub(crate) const ROLLBACK_POLICY: &str = "supported";
const LEGACY_ACTIVATION_POLICY: &str = "user-installs-standalone-archive";
const LEGACY_ROLLBACK_POLICY: &str = "not-managed-by-butler";

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
) -> Result<AgentArtifact, UpdateError> {
    let resolved_source = if source.starts_with("http://")
        || source.starts_with("https://")
        || source.starts_with("file://")
        || std::path::Path::new(source).is_absolute()
    {
        source.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateManifestSourceInvalid, source))?
            .join(source)
            .to_string_lossy()
            .into_owned()
    };
    let bytes = read_manifest(client, shutdown, &resolved_source).await?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateCode::UpdateManifestTooLarge.into());
    }
    let manifest: Value = serde_json::from_slice(&bytes)
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateManifestInvalid, source))?;
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
        .ok_or(UpdateCode::UpdateManifestArtifactsMissing)?;
    let mut candidates = Vec::new();
    for artifact in &artifacts {
        let component = artifact
            .get("component")
            .or_else(|| artifact.get("id"))
            .and_then(Value::as_str)
            .ok_or(UpdateCode::UpdateManifestComponentInvalid)?;
        if !matches!(component, "service" | "agent" | "butler-agent") {
            if !matches!(component, "app" | "butler-app" | "app-server") {
                return Err(UpdateCode::UpdateManifestComponentInvalid.into());
            }
            continue;
        }
        candidates.push(artifact);
    }
    // Only the artifact built for this host is ever selected: never one that
    // names no platform, or a platform this host cannot run.
    let host_platform = butler_platform::launcher::release_platform();
    let selected = candidates
        .iter()
        .copied()
        .find(|artifact| string(artifact, "platform") == Some(host_platform.as_str()))
        .ok_or(UpdateCode::UpdateManifestAgentPlatformMissing)?;
    validate_source_contract(selected)?;
    let version = required_version(selected)?;
    let actual_channel = string(selected, "channel").or(channel).unwrap_or("stable");
    let platform = host_platform.as_str();
    let url = string_any(selected, &["artifact_url", "downloadUrl", "url"]);
    let sha256 = string(selected, "sha256").map(str::to_ascii_lowercase);
    if sha256
        .as_deref()
        .is_some_and(|digest| !valid_sha256(digest))
    {
        return Err(UpdateCode::UpdateManifestSha256Invalid.into());
    }
    if let Some(integrity) = selected.get("integrity") {
        if string(integrity, "digestAlgorithm") != Some("sha256") {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
        if string(integrity, "signature").is_some() {
            return Err(UpdateCode::UpdateSignatureUnsupported.into());
        }
        if string(integrity, "digest").is_some_and(|digest| {
            sha256
                .as_deref()
                .is_none_or(|sha| !digest.eq_ignore_ascii_case(sha))
        }) {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
    }
    if string(selected, "signature").is_some() {
        return Err(UpdateCode::UpdateSignatureUnsupported.into());
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

fn validate_source_contract(artifact: &Value) -> Result<(), UpdateError> {
    for (field, expected) in [
        ("product", "butler-agent"),
        ("canonical_component", "agent"),
        ("profile", "agent-standalone"),
        ("update_policy", "explicit"),
        ("restart_policy", "restart-service"),
        ("updater_owner", "butler-agent"),
        ("payload_format", "agent-archive"),
        ("staging_policy", "butler-data-updates"),
    ] {
        if string(artifact, field) != Some(expected) {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
    }
    // Butler activates and rolls back what it installs. Manifests published
    // before that (`user-installs-standalone-archive`, `not-managed-by-butler`)
    // describe the same archive and stay accepted.
    for (field, accepted) in [
        (
            "activation_policy",
            [ACTIVATION_POLICY, LEGACY_ACTIVATION_POLICY],
        ),
        ("rollback_policy", [ROLLBACK_POLICY, LEGACY_ROLLBACK_POLICY]),
    ] {
        if !string(artifact, field).is_some_and(|value| accepted.contains(&value)) {
            return Err(UpdateCode::UpdateManifestIncompatible.into());
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
            return Err(UpdateCode::UpdateManifestIncompatible.into());
        }
    }
    if let Some(protocol) = artifact
        .get("protocol_compatibility")
        .or_else(|| artifact.get("protocolCompatibility"))
    {
        for field in ["protocol", "minimumAgentProtocol", "maximumAgentProtocol"] {
            if protocol.get(field).and_then(Value::as_str) != Some("butler.agent.v1") {
                return Err(UpdateCode::UpdateManifestIncompatible.into());
            }
        }
    }
    Ok(())
}

/// The manifest's required, non-blank `version`.
fn required_version(artifact: &Value) -> Result<&str, UpdateError> {
    let field = "version";
    string(artifact, field)
        .filter(|value| !value.trim().is_empty())
        .ok_or(UpdateCode::UpdateManifestVersionMissing.into())
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
    fn agent_archive_contract_accepts_aliases_and_rejects_bundled_app_components() {
        {
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
                "activationPolicy": "butler-managed",
                "rollbackPolicy": "supported"
            }));
            validate_source_contract(&artifact).expect("source manifest fields are accepted");
            assert_eq!(artifact["component"], "agent");
            assert_eq!(
                artifact["artifact_url"],
                "https://example.invalid/agent.tar.gz"
            );
        }
        {
            let artifact = json!({"bundled_components": ["service", "app"]});
            assert_eq!(
                validate_source_contract(&artifact).unwrap_err().code(),
                "update_manifest_incompatible"
            );
        }
    }
}
