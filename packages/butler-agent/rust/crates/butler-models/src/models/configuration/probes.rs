use serde_json::Value;

use super::super::catalog::hosted_provider;
use super::super::{ImageProbeEvidence, ProviderAuthMethod, normalize_hosted_api_base_url};
use super::{array, first_by_key, text};

pub(super) fn read(config: &Value) -> Vec<ImageProbeEvidence> {
    first_by_key(
        array(config.pointer("/models/image_probe_evidence"))
            .iter()
            .filter_map(normalize),
        |record| {
            // The source duplicate identity excludes model_ref/revision/digest;
            // the first record for one provider/model/auth/base/carrier wins.
            vec![
                record.provider_id.clone(),
                record.model_id.clone(),
                match record.auth_type {
                    ProviderAuthMethod::ApiKey => "api_key",
                    ProviderAuthMethod::CodexOauth => "codex_oauth",
                }
                .into(),
                match record.auth_type {
                    ProviderAuthMethod::ApiKey => record.credential_id.as_deref().unwrap_or(""),
                    ProviderAuthMethod::CodexOauth => {
                        record.auth_profile.as_deref().unwrap_or("codex_oauth")
                    }
                }
                .into(),
                record.api_base_url.clone(),
                record.carrier_protocol.clone(),
            ]
        },
    )
}

fn normalize(value: &Value) -> Option<ImageProbeEvidence> {
    let provider_id = hosted_provider(value.get("provider_id")?.as_str()?)?;
    let auth_type = match value.get("auth_type")?.as_str()? {
        "api_key" => ProviderAuthMethod::ApiKey,
        "codex_oauth" => ProviderAuthMethod::CodexOauth,
        _ => return None,
    };
    let model_id = text(value.get("model_id"))?.into();
    let model_ref = text(value.get("model_ref"))?;
    if !model_ref.starts_with(&format!("{provider_id}/")) {
        return None;
    }
    let api_base_url = normalize_hosted_api_base_url(value.get("api_base_url"))?;
    let carrier_protocol = value.get("carrier_protocol")?.as_str()?;
    if !matches!(
        carrier_protocol,
        "openai_responses" | "openai_chat_completions" | "zai_mcp_vision" | "fake_vision"
    ) {
        return None;
    }
    let credential_id = text(value.get("credential_id")).map(str::to_owned);
    let auth_profile = text(value.get("auth_profile")).map(str::to_owned);
    if (auth_type == ProviderAuthMethod::ApiKey && credential_id.is_none())
        || (auth_type == ProviderAuthMethod::CodexOauth && auth_profile.is_none())
    {
        return None;
    }
    Some(ImageProbeEvidence {
        provider_id,
        model_id,
        model_ref: model_ref.into(),
        auth_type,
        credential_id,
        auth_profile,
        api_base_url,
        carrier_protocol: carrier_protocol.into(),
        endpoint_profile_id: text(value.get("endpoint_profile_id"))?.into(),
        capability_revision: text(value.get("capability_revision"))?.into(),
        capability_digest: text(value.get("capability_digest"))?.into(),
        verified_at: text(value.get("verified_at"))?.into(),
    })
}
