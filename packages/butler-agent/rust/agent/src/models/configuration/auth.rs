//! Request-local OpenAI API-key and Codex OAuth resolution.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use reqwest::{Client, Url};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

mod io;
mod jwt;
mod profile;
mod url;
use io::{read_json_object, response_json, write_mode_600};
use jwt::{account_id_from_access_token, codex_account_id, email_from_access_token};
pub(crate) use profile::OpenAiAuthProfile;
use profile::{copy_string, update_claim, update_number, update_string};

use super::{ModelConfigurationClock, ModelConfigurationEnvironment};
use crate::models::{ProviderAuth, ProviderAuthMode};

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

pub(super) struct AuthOwner<'a> {
    pub(super) data_root: &'a Path,
    pub(super) environment: &'a ModelConfigurationEnvironment,
    pub(super) clock: &'a dyn ModelConfigurationClock,
    pub(super) client: &'a Client,
}

#[derive(Clone)]
pub(crate) struct AuthError {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
}

impl std::fmt::Debug for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthError")
            .field("code", &self.code)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for AuthError {}

impl AuthOwner<'_> {
    pub(super) async fn resolve_openai(&self) -> Result<ProviderAuth, AuthError> {
        if let Some(key) = trimmed(self.environment.openai_api_key.as_deref()) {
            return Ok(ProviderAuth::ApiKey(key.to_owned()));
        }
        self.resolve_codex().await
    }

    pub(super) async fn resolve_codex(&self) -> Result<ProviderAuth, AuthError> {
        if let Some(mut profile) = self.read_butler_profile().await
            && !profile.access_token.is_empty()
        {
            if self.is_expiring(&profile) {
                profile = self.refresh(profile).await?;
            }
            let account_id =
                account_id_from_access_token(&profile.access_token).unwrap_or_default();
            return self.codex_auth(
                ProviderAuthMode::CodexSubscription,
                &profile.access_token,
                account_id,
            );
        }
        let codex_auth_path = self.codex_auth_path()?;
        if let Some(auth) = read_json_object(&codex_auth_path).await
            && let Some(token) = auth
                .get("tokens")
                .and_then(Value::as_object)
                .and_then(|tokens| tokens.get("access_token"))
                .and_then(Value::as_str)
                .and_then(|value| trimmed(Some(value)))
        {
            let account_id = codex_account_id(&auth, token).unwrap_or_default();
            return self.codex_auth(ProviderAuthMode::CodexOauth, token, account_id);
        }
        Err(error(
            "provider_auth_missing",
            "Codex subscription login is required for OpenAI Codex OAuth auth.",
        ))
    }

    fn codex_auth(
        &self,
        mode: ProviderAuthMode,
        token: &str,
        account_id: String,
    ) -> Result<ProviderAuth, AuthError> {
        let originator = trimmed(self.environment.oauth_originator.as_deref())
            .unwrap_or("butler")
            .to_owned();
        let user_agent = if let Some(value) = trimmed(self.environment.codex_user_agent.as_deref())
        {
            value.to_owned()
        } else {
            let platform = required(
                self.environment.os_platform.as_ref(),
                "provider_os_facts_missing",
            )?;
            let release = required(
                self.environment.os_release.as_ref(),
                "provider_os_facts_missing",
            )?;
            let arch = required(
                self.environment.os_arch.as_ref(),
                "provider_os_facts_missing",
            )?;
            format!("butler ({platform} {release}; {arch})")
        };
        Ok(ProviderAuth::Codex {
            mode,
            authorization: format!("Bearer {token}"),
            account_id,
            user_agent,
            originator,
        })
    }

    pub(super) async fn read_butler_profile(&self) -> Option<OpenAiAuthProfile> {
        let raw = read_json_object(&self.butler_profile_path()).await?;
        if raw.get("type").and_then(Value::as_str) != Some("oauth") {
            return None;
        }
        let access_token = raw.get("accessToken")?.as_str()?.to_owned();
        Some(OpenAiAuthProfile {
            refresh_token: raw
                .get("refreshToken")
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at: raw.get("expiresAt").and_then(Value::as_f64),
            access_token,
            raw,
        })
    }

    fn is_expiring(&self, profile: &OpenAiAuthProfile) -> bool {
        profile.expires_at.is_some_and(|expires| {
            expires != 0.0 && (self.clock.now_epoch_millis() as f64) > expires - 60_000.0
        })
    }

    async fn refresh(&self, profile: OpenAiAuthProfile) -> Result<OpenAiAuthProfile, AuthError> {
        let client_id = trimmed(self.environment.oauth_client_id.as_deref()).unwrap_or(CLIENT_ID);
        let Some(refresh_token) = profile.refresh_token.as_deref() else {
            return Ok(profile);
        };
        if client_id.is_empty() {
            return Ok(profile);
        }
        let response = self
            .client
            .post(url::token_url(self.environment)?)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", refresh_token),
            ])
            .send()
            .await
            .map_err(|_| {
                error(
                    "provider_auth_refresh_transport",
                    "OpenAI OAuth refresh failed.",
                )
            })?;
        if !response.status().is_success() {
            return Ok(profile);
        }
        let token = response_json(response).await.map_err(|()| {
            error(
                "provider_auth_refresh_invalid",
                "OpenAI OAuth refresh response was invalid.",
            )
        })?;
        let mut raw = profile.raw;
        let access = token
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or(&profile.access_token)
            .to_owned();
        raw.insert("accessToken".into(), access.clone().into());
        update_string(&mut raw, "refreshToken", token.get("refresh_token"));
        update_number(
            &mut raw,
            "expiresAt",
            token.get("expires_in"),
            self.clock.now_epoch_millis(),
        );
        update_claim(&mut raw, "accountId", account_id_from_access_token(&access));
        update_claim(&mut raw, "email", email_from_access_token(&access));
        update_string(&mut raw, "scope", token.get("scope"));
        raw.insert("updatedAt".into(), self.clock.now_iso().into());
        self.write_profile(&raw).await?;
        Ok(OpenAiAuthProfile {
            refresh_token: raw
                .get("refreshToken")
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at: raw.get("expiresAt").and_then(Value::as_f64),
            access_token: access,
            raw,
        })
    }

    pub(crate) async fn exchange_code(
        &self,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<OpenAiAuthProfile, AuthError> {
        let client_id = trimmed(self.environment.oauth_client_id.as_deref()).unwrap_or(CLIENT_ID);
        let response = self
            .client
            .post(url::token_url(self.environment)?)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
            ])
            .send()
            .await
            .map_err(|_| {
                error(
                    "provider_auth_exchange_transport",
                    "OpenAI OAuth token exchange failed.",
                )
            })?;
        if !response.status().is_success() {
            return Err(error(
                "provider_auth_exchange_http",
                "OpenAI OAuth token exchange failed.",
            ));
        }
        let token = response_json(response).await.map_err(|()| {
            error(
                "provider_auth_exchange_invalid",
                "OpenAI OAuth token exchange response was invalid.",
            )
        })?;
        let access = token
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if access.is_empty() {
            return Err(error(
                "provider_auth_exchange_missing_token",
                "OpenAI OAuth token exchange did not return an access token.",
            ));
        }
        let now = self.clock.now_epoch_millis();
        let mut raw = Map::new();
        raw.insert("provider".into(), "openai-codex".into());
        raw.insert("type".into(), "oauth".into());
        raw.insert("accessToken".into(), access.clone().into());
        copy_string(&mut raw, "refreshToken", token.get("refresh_token"));
        update_number(&mut raw, "expiresAt", token.get("expires_in"), now);
        update_claim(&mut raw, "accountId", account_id_from_access_token(&access));
        update_claim(&mut raw, "email", email_from_access_token(&access));
        copy_string(&mut raw, "scope", token.get("scope"));
        raw.insert("provenance".into(), "codex-subscription-oauth".into());
        raw.insert("updatedAt".into(), self.clock.now_iso().into());
        Ok(OpenAiAuthProfile {
            refresh_token: raw
                .get("refreshToken")
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at: raw.get("expiresAt").and_then(Value::as_f64),
            access_token: access,
            raw,
        })
    }

    pub(crate) async fn write_profile_value(
        &self,
        profile: &OpenAiAuthProfile,
    ) -> Result<(), AuthError> {
        self.write_profile(&profile.raw).await
    }

    async fn write_profile(&self, profile: &Map<String, Value>) -> Result<(), AuthError> {
        let path = self.butler_profile_path();
        let parent = path.parent().ok_or_else(|| {
            error(
                "provider_auth_path_invalid",
                "OpenAI auth profile path is invalid.",
            )
        })?;
        tokio::fs::create_dir_all(parent).await.map_err(|_| {
            error(
                "provider_auth_write_failed",
                "OpenAI auth profile could not be written.",
            )
        })?;
        let mut bytes =
            serde_json::to_vec_pretty(&Value::Object(profile.clone())).map_err(|_| {
                error(
                    "provider_auth_write_failed",
                    "OpenAI auth profile could not be written.",
                )
            })?;
        bytes.push(b'\n');
        write_mode_600(&path, &bytes).await
    }

    pub(crate) fn authorize_url(
        &self,
        redirect_uri: &str,
        challenge: &str,
        state: &str,
        scope: Option<&str>,
    ) -> Result<Url, AuthError> {
        url::authorize(self.environment, redirect_uri, challenge, state, scope)
    }

    fn butler_profile_path(&self) -> PathBuf {
        let configured = self
            .environment
            .butler_codex_auth_profile
            .clone()
            .or_else(|| self.environment.butler_openai_auth_profile.clone());
        match configured {
            Some(path) if path.is_absolute() => path,
            Some(path) => self.data_root.join(path),
            None => self.data_root.join("auth/openai-codex.json"),
        }
    }

    fn codex_auth_path(&self) -> Result<PathBuf, AuthError> {
        if let Some(path) = &self.environment.codex_auth_json {
            return Ok(path.clone());
        }
        self.environment
            .codex_home
            .as_ref()
            .map(|home| home.join("auth.json"))
            .ok_or_else(|| {
                error(
                    "provider_home_facts_missing",
                    "Required provider home facts are unavailable.",
                )
            })
    }
}

pub(crate) fn generate_pkce_verifier() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn required<'a>(value: Option<&'a String>, code: &'static str) -> Result<&'a str, AuthError> {
    value
        .map(String::as_str)
        .and_then(|value| trimmed(Some(value)))
        .ok_or_else(|| error(code, "Required host identity facts are unavailable."))
}
fn trimmed(value: Option<&str>) -> Option<&str> {
    value
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
}
fn error(code: &'static str, message: &'static str) -> AuthError {
    AuthError { code, message }
}
