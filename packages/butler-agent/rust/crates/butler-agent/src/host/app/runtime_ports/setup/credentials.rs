//! API keys: checking a key with its provider without storing it and
//! storing it under a generated name (first-run setup, #230); listing,
//! replacing and deleting saved keys (#217). Keys are kept in the OS
//! credential store; the credentials file holds only their metadata.

use std::path::Path;

use butler_gateway::gateway::{
    AppCredentialReplaceInput, AppProviderKeyInput, GatewayApplicationError,
    ProviderKeyVerificationView, ReplacedCredentialView, SavedCredentialView,
};
use butler_models::models::{
    CredentialError, CredentialList, DeletedCredential, ModelCatalogError, ModelConfiguration,
    ProviderKeyCheckError, ProviderKeySaveError,
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

/// The saved keys, masked, and where new keys go.
pub(super) async fn list(
    configuration: &ModelConfiguration,
    root: &Path,
) -> Result<CredentialList, GatewayApplicationError> {
    configuration
        .list_provider_credentials(root)
        .await
        .map_err(credential_error)
}

/// Replaces the key of the saved credential `name`.
pub(super) async fn replace(
    configuration: &ModelConfiguration,
    name: &str,
    input: &AppCredentialReplaceInput,
    root: &Path,
) -> Result<ReplacedCredentialView, GatewayApplicationError> {
    let credential = configuration
        .replace_provider_credential(name, &input.api_key, input.verify, root)
        .await
        .map_err(credential_error)?;
    Ok(ReplacedCredentialView { credential })
}

/// Deletes the saved credential `name` and its key.
pub(super) async fn delete(
    configuration: &ModelConfiguration,
    name: &str,
    force: bool,
    root: &Path,
) -> Result<DeletedCredential, GatewayApplicationError> {
    configuration
        .delete_provider_credential(name, force, root)
        .await
        .map_err(credential_error)
}

/// A key operation's public error: a stable code, a plain message, never
/// the key.
fn credential_error(error: CredentialError) -> GatewayApplicationError {
    let status = match &error {
        CredentialError::Check(check) => return key_check_error(check),
        CredentialError::NotFound => 404,
        CredentialError::Ambiguous
        | CredentialError::InUse { .. }
        | CredentialError::InUseByDefault { .. }
        | CredentialError::SecretMissing
        | CredentialError::File(ModelCatalogError::Rejected(_)) => 409,
        CredentialError::Store(_) => 503,
        CredentialError::File(_) => return GatewayApplicationError::internal_from(error),
    };
    GatewayApplicationError::Public {
        status,
        code: error.code().into(),
        message: error.to_string(),
        source: Some(std::sync::Arc::new(error)),
    }
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
