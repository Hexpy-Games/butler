use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use super::{
    CredentialView, ModelCatalogSnapshot, ModelProviderMetadata, ProviderAuthMethod,
    default_hosted_provider_api_base_url,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct RegisteredHostedModelConfig {
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub model_ref: String,
    pub display_name: String,
    pub auth_type: ProviderAuthMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ImageProbeEvidence {
    pub provider_id: String,
    pub model_id: String,
    pub model_ref: String,
    pub auth_type: ProviderAuthMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_profile: Option<String>,
    pub api_base_url: String,
    pub carrier_protocol: String,
    pub endpoint_profile_id: String,
    pub capability_revision: String,
    pub capability_digest: String,
    pub verified_at: String,
}

pub(crate) fn registered_hosted_model_metadata(
    configs: &[RegisteredHostedModelConfig],
    catalog: &ModelCatalogSnapshot,
    credentials: &[CredentialView],
    probes: &[ImageProbeEvidence],
    codex_probe_base_url: Option<&str>,
) -> Vec<ModelProviderMetadata> {
    configs
        .iter()
        .filter_map(|config| {
            let mut base = catalog.find_static_model_metadata(Some(&config.model_ref))?;
            if base.provider_id != config.provider_id || !base.runtime_supported {
                return None;
            }
            let credential = config
                .credential_id
                .as_deref()
                .and_then(|id| credentials.iter().find(|value| value.id == id));
            let probe = probes
                .iter()
                .find(|probe| probe_matches(probe, config, &base, codex_probe_base_url));
            base.display_name = if config.display_name.is_empty() {
                base.display_name
            } else {
                config.display_name.clone()
            };
            base.registered = Some(true);
            base.auth_type = Some(config.auth_type);
            base.credential_id = config.credential_id.clone();
            base.credential_label = credential.map(|value| value.label.clone());
            base.credential_masked_value = credential.map(|value| value.masked_value.clone());
            base.api_base_url = config.api_base_url.clone().or_else(|| {
                default_hosted_provider_api_base_url(&config.provider_id).map(str::to_owned)
            });
            base.runtime_supported = true;
            base.image_route_health = Some(if probe.is_some() {
                "healthy".into()
            } else {
                base.image_route_health
                    .unwrap_or_else(|| "unchecked".into())
            });
            if let Some(probe) = probe {
                base.image_capability_verified_at = Some(probe.verified_at.clone());
            }
            Some(base)
        })
        .collect()
}

fn probe_matches(
    probe: &ImageProbeEvidence,
    config: &RegisteredHostedModelConfig,
    base: &ModelProviderMetadata,
    codex_probe_base_url: Option<&str>,
) -> bool {
    let effective_url = config
        .api_base_url
        .as_deref()
        .or_else(|| {
            (config.auth_type == ProviderAuthMethod::CodexOauth)
                .then_some(codex_probe_base_url.unwrap_or("https://chatgpt.com/backend-api"))
        })
        .or_else(|| default_hosted_provider_api_base_url(&config.provider_id))
        .or(Some("https://api.openai.com/v1"));
    probe.provider_id == config.provider_id
        && probe.model_id == config.model_id
        && probe.model_ref == config.model_ref
        && probe.auth_type == config.auth_type
        && match config.auth_type {
            ProviderAuthMethod::ApiKey => probe.credential_id == config.credential_id,
            ProviderAuthMethod::CodexOauth => {
                probe.auth_profile.as_deref()
                    == config.auth_profile.as_deref().or(Some("codex_oauth"))
            }
        }
        && Some(probe.api_base_url.as_str()) == effective_url
        && Some(probe.carrier_protocol.as_str()) == base.image_carrier_protocol.as_deref()
        && Some(probe.endpoint_profile_id.as_str())
            == base
                .image_endpoint_profile_id
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
        && Some(probe.capability_revision.as_str())
            == base
                .image_capability_revision
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
        && Some(probe.capability_digest.as_str())
            == base
                .image_capability_digest
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
}

pub(crate) fn normalize_registered_hosted_model(
    value: &Value,
    catalog: &ModelCatalogSnapshot,
    now: &str,
) -> Option<RegisteredHostedModelConfig> {
    let input = value.as_object()?;
    let provider_id = hosted_provider(input.get("provider_id")?.as_str()?)?;
    let auth_type = match input.get("auth_type")?.as_str()? {
        "api_key" => ProviderAuthMethod::ApiKey,
        "codex_oauth" => ProviderAuthMethod::CodexOauth,
        _ => return None,
    };
    if auth_type == ProviderAuthMethod::CodexOauth && provider_id != "openai" {
        return None;
    }
    let raw_requested = input
        .get("model_id")
        .filter(|value| !value.is_null())
        .or_else(|| input.get("model_ref").filter(|value| !value.is_null()));
    let requested = js_string(raw_requested)?;
    let requested = crate::public_text::trim_js_whitespace(&requested);
    let requested = if requested.contains('/') {
        requested.to_owned()
    } else {
        format!("{provider_id}/{requested}")
    };
    let base = catalog.find_static_model_metadata(Some(&requested))?;
    if base.provider_id != provider_id || !base.runtime_supported {
        return None;
    }
    let credential_id = text(input.get("credential_id"));
    if auth_type == ProviderAuthMethod::ApiKey && credential_id.is_none() {
        return None;
    }
    let auth_profile = text(input.get("auth_profile"))
        .or_else(|| (auth_type == ProviderAuthMethod::CodexOauth).then(|| "codex_oauth".into()));
    Some(RegisteredHostedModelConfig {
        provider_id,
        provider_label: base.provider_label,
        model_id: base.model_id,
        model_ref: base.model_ref,
        display_name: safe_label(input.get("display_name"), &base.display_name),
        auth_type,
        credential_id,
        auth_profile,
        api_base_url: normalize_hosted_api_base_url(input.get("api_base_url")),
        created_at: input
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or(now)
            .into(),
        updated_at: input
            .get("updated_at")
            .and_then(Value::as_str)
            .unwrap_or(now)
            .into(),
        extensions: Map::new(),
    })
}

pub(crate) fn normalize_hosted_api_base_url(value: Option<&Value>) -> Option<String> {
    let text = crate::public_text::trim_js_whitespace(value.and_then(Value::as_str)?);
    if text.is_empty() {
        return None;
    }
    let mut url = Url::parse(text).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_fragment(None);
    url.set_query(None);
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Some(url.as_str().trim_end_matches('/').to_owned())
}
pub(in crate::models) fn hosted_provider(value: &str) -> Option<String> {
    matches!(
        value,
        "openai"
            | "anthropic"
            | "google"
            | "xai"
            | "qwen"
            | "kimi"
            | "zai"
            | "zai-api"
            | "opencode-go"
    )
    .then(|| value.into())
}
fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
fn js_string(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(Value::Number(value)) => crate::json::stringify(&Value::Number(value.clone())).ok(),
        Some(Value::Object(_)) => Some("[object Object]".into()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::Null => Some(String::new()),
                _ => js_string(Some(value)),
            })
            .collect::<Option<Vec<_>>>()
            .map(|values| values.join(",")),
    }
}
pub(in crate::models) fn safe_label(value: Option<&Value>, fallback: &str) -> String {
    let mut compact = value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        return fallback.into();
    }
    if compact.encode_utf16().count() > 80 {
        let mut units = 0;
        compact = compact
            .chars()
            .take_while(|character| {
                let next = units + character.len_utf16();
                if next > 79 {
                    return false;
                }
                units = next;
                true
            })
            .collect();
        compact = compact.trim_end_matches(js_whitespace).into();
    }
    compact
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' |
        '\u{3000}' | '\u{feff}')
}
