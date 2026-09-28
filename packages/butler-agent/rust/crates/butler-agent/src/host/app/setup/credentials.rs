//! API keys during first-run setup (#230): checking a key with its
//! provider without storing it, and storing it under a generated name.
//! Keys stay in the existing credentials file for now (#217 moves them to
//! the Keychain).

use std::path::Path;

use butler_gateway::gateway::{
    AppProviderKeyInput, GatewayApplicationError, ProviderKeyVerificationView, SavedCredentialView,
};
use butler_models::models::{ModelConfiguration, ProviderKeyCheckError, ProviderKeySaveError};

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
    input: &AppProviderKeyInput,
    root: &Path,
) -> Result<SavedCredentialView, GatewayApplicationError> {
    let saved = configuration
        .save_provider_key(&input.provider_id, &input.api_key, root)
        .await
        .map_err(|error| match error {
            ProviderKeySaveError::Invalid(invalid) => key_check_error(&invalid),
            ProviderKeySaveError::Storage(_) => GatewayApplicationError::internal_from(error),
            ProviderKeySaveError::Rejected(_) => GatewayApplicationError::Public {
                status: 400,
                code: "provider_credential_save_failed".into(),
                message: error.to_string(),
                source: None,
            },
        })?;
    Ok(SavedCredentialView {
        credential: saved.credential,
        created: saved.created,
    })
}

/// The public error of a rejected key: the stable code and a plain
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
