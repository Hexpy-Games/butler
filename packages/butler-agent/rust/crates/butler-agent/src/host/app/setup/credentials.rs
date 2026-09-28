//! API keys during first-run setup (#230): checking a key with its
//! provider without storing it, and storing it under a generated name.
//! Keys stay in the existing credentials file for now (#217 moves them to
//! the Keychain).

use std::path::Path;

use butler_gateway::gateway::{
    AppProviderKeyInput, GatewayApplicationError, ProviderKeyVerificationView, SavedCredentialView,
};
use butler_models::models::{
    CredentialView, ModelConfiguration, ProviderCredentialMutation, ProviderKeyCheckError,
};

/// Checks `input.api_key` with its provider; nothing is stored.
pub(super) async fn verify(
    configuration: &ModelConfiguration,
    input: &AppProviderKeyInput,
) -> Result<ProviderKeyVerificationView, GatewayApplicationError> {
    let check = configuration
        .check_provider_key(&input.provider_id, &input.api_key)
        .await
        .map_err(|error| key_check_error(&error))?;
    Ok(ProviderKeyVerificationView {
        valid: true,
        verified: check.verified,
        models: check.models,
    })
}

/// Stores `input.api_key`, reusing the saved credential when the provider
/// already has this key.
pub(super) async fn save(
    configuration: &ModelConfiguration,
    input: AppProviderKeyInput,
    root: &Path,
) -> Result<SavedCredentialView, GatewayApplicationError> {
    // A key is later sent as a header value: control characters never are.
    if input.api_key.chars().any(char::is_control) {
        return Err(key_check_error(&ProviderKeyCheckError::MalformedKey));
    }
    let read = configuration
        .read()
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    if let Some(credential) = read.credential_with_secret(&input.provider_id, &input.api_key) {
        return Ok(SavedCredentialView {
            credential,
            created: false,
        });
    }
    let label = generated_label(
        &input.provider_id,
        &read.catalog.view().provider_credentials,
    );
    let credential = configuration
        .upsert_provider_credential(
            &ProviderCredentialMutation {
                provider_id: input.provider_id,
                api_key: input.api_key,
                label: Some(label),
                credential_id: None,
            },
            Some(root),
        )
        .await
        .map_err(|error| GatewayApplicationError::Public {
            status: 400,
            code: "provider_credential_save_failed".into(),
            message: error.to_string(),
            source: None,
        })?;
    Ok(SavedCredentialView {
        credential,
        created: true,
    })
}

/// `provider_id`, then `provider_id-2`, `-3`, ... : the first name no saved
/// credential uses.
pub(super) fn generated_label(provider_id: &str, saved: &[CredentialView]) -> String {
    let taken = |label: &str| saved.iter().any(|credential| credential.label == label);
    if !taken(provider_id) {
        return provider_id.to_owned();
    }
    // Among `saved.len() + 1` candidates at least one is free.
    (2..=saved.len() + 2)
        .map(|number| format!("{provider_id}-{number}"))
        .find(|label| !taken(label))
        .unwrap_or_else(|| provider_id.to_owned())
}

/// The public error of a failed key check: the stable code and a plain
/// message; the key never appears in either.
fn key_check_error(error: &ProviderKeyCheckError) -> GatewayApplicationError {
    let status = match error {
        ProviderKeyCheckError::InvalidKey | ProviderKeyCheckError::NoAccess => 422,
        ProviderKeyCheckError::RateLimited => 429,
        ProviderKeyCheckError::Network { .. }
        | ProviderKeyCheckError::ProviderUnavailable { .. } => 502,
        ProviderKeyCheckError::UnsupportedProvider | ProviderKeyCheckError::MalformedKey => 400,
    };
    GatewayApplicationError::Public {
        status,
        code: error.code().into(),
        message: error.to_string(),
        source: None,
    }
}

#[cfg(test)]
mod tests {
    use butler_models::models::ProviderAuthMethod;

    use super::*;

    fn saved(label: &str) -> CredentialView {
        CredentialView {
            id: format!("cred_{label}"),
            provider_id: "openai".into(),
            auth_type: ProviderAuthMethod::ApiKey,
            label: label.into(),
            masked_value: "sk-...x".into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn generated_names_count_up_from_the_provider_id() {
        assert_eq!(generated_label("openai", &[]), "openai");
        assert_eq!(generated_label("openai", &[saved("openai")]), "openai-2");
        assert_eq!(
            generated_label(
                "openai",
                &[saved("openai"), saved("openai-2"), saved("work")]
            ),
            "openai-3"
        );
    }
}
