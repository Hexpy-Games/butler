//! Request-local API-key and official ChatGPT registration resolution.
use super::{ModelConfigurationClock, ModelConfigurationEnvironment, chatgpt};
use crate::models::ProviderAuth;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
pub(super) mod io;
pub(super) struct AuthOwner<'a> {
    pub(super) data_root: &'a Path,
    pub(super) environment: &'a ModelConfigurationEnvironment,
    pub(super) clock: &'a Arc<dyn ModelConfigurationClock>,
    pub(super) client: &'a reqwest::Client,
    pub(super) revision: &'a tokio::sync::watch::Sender<u64>,
}
/// A provider authentication failure: a static wire code and user-facing
/// message, plus the transport, filesystem or JSON error that caused it.
#[derive(Clone, thiserror::Error)]
#[error("{message}")]
pub struct AuthError {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
    pub(super) reason: Option<&'static str>,
    #[source]
    source: Option<Arc<dyn std::error::Error + Send + Sync>>,
}

impl AuthError {
    /// Records the underlying error.
    #[must_use]
    pub(super) fn with_source(
        mut self,
        source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
    ) -> Self {
        self.source = Some(Arc::from(source.into()));
        self
    }
}

/// Debug omits the source: transport errors may echo request details.
impl std::fmt::Debug for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthError")
            .field("code", &self.code)
            .finish_non_exhaustive()
    }
}

impl AuthOwner<'_> {
    pub(super) async fn resolve_openai(&self) -> Result<ProviderAuth, AuthError> {
        self.resolve_openai_after(None).await
    }
    pub(super) async fn resolve_openai_after(
        &self,
        rejected: Option<&str>,
    ) -> Result<ProviderAuth, AuthError> {
        if let Some(key) = trimmed(self.environment.openai_api_key.as_deref()) {
            return Ok(ProviderAuth::ApiKey(zeroize::Zeroizing::new(
                key.to_owned(),
            )));
        }
        self.resolve_chatgpt(rejected).await
    }
    pub(super) async fn resolve_chatgpt(
        &self,
        rejected: Option<&str>,
    ) -> Result<ProviderAuth, AuthError> {
        let paths =
            chatgpt::store::paths(self.data_root, self.environment.chatgpt_auth_dir.as_deref());
        let raw = chatgpt::store::read(&paths.registration)
            .await
            .map_err(chatgpt_error)?;
        crate::models::provider::chatgpt_plan::observe_registration(
            &paths.registration,
            chatgpt::registration(&raw),
        );
        if raw["client_id"].as_str().is_none_or(str::is_empty) && raw["sign_in_required"].is_null()
        {
            let legacy = paths.legacy.clone();
            let legacy = tokio::task::spawn_blocking(move || {
                std::fs::metadata(legacy).is_ok_and(|m| m.len() > 0)
            })
            .await
            .map_err(|_| chatgpt_error("chatgpt_store_unreadable"))?;
            let mut failure = error(
                if legacy {
                    "chatgpt_sign_in_required"
                } else {
                    "provider_auth_missing"
                },
                if legacy {
                    "ChatGPT sign-in is required (legacy)."
                } else {
                    "ChatGPT sign-in is required."
                },
            );
            failure.reason = legacy.then_some("legacy");
            return Err(failure);
        }
        validate(&raw)?;
        let raw = chatgpt::refresh::resolve(self, paths, raw, rejected).await?;
        validate(&raw)?;
        let token = raw["access_token"]
            .as_str()
            .ok_or_else(|| chatgpt_error("chatgpt_sign_in_required"))?;
        butler_log::register_secret(token);
        Ok(ProviderAuth::ChatGptPlan {
            authorization: zeroize::Zeroizing::new(format!("Bearer {token}")),
            registration: chatgpt::registration(&raw)
                .ok_or_else(|| chatgpt_error("chatgpt_sign_in_required"))?,
        })
    }
}
fn validate(raw: &serde_json::Value) -> Result<(), AuthError> {
    if !raw["sign_in_required"].is_null()
        || !chatgpt::signed_in(raw)
        || chatgpt::registration(raw).is_none()
    {
        return Err(chatgpt_error("chatgpt_sign_in_required"));
    }
    if !chatgpt::plan_enabled(raw) {
        return Err(chatgpt_error("chatgpt_plan_not_enabled"));
    }
    Ok(())
}
pub(super) fn chatgpt_error(code: &'static str) -> AuthError {
    error(code, "ChatGPT plan authentication could not be resolved.")
}
pub fn generate_pkce_verifier() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
}
fn error(code: &'static str, message: &'static str) -> AuthError {
    AuthError {
        code,
        message,
        source: None,
        reason: None,
    }
}
