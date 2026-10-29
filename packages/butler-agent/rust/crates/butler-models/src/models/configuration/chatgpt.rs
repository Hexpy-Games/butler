//! Official ChatGPT account registration. Model transport switches in P2.
pub mod authority;
pub mod authorize;
pub mod credentials;
pub mod exchange;
pub mod id_token;
pub mod models;
mod search;
pub use search::finalize_search;
pub mod refresh;
pub mod revoke;
pub mod store;

use super::ModelConfiguration;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const AGENT_NAME_HINT: &str = "Butler";
pub const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
pub const DEFAULT_ISSUER: &str = "https://auth.openai.com";
pub const DEFAULT_API_BASE: &str = "https://api.openai.com/v1";
pub type Error = &'static str;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignInKind {
    #[default]
    Default,
    NewAccount,
    EnablePlan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGptAccountStatus {
    SignedOut,
    LegacySignInRequired,
    SignInRequired,
    PlanOff,
    SignedIn,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatGptAccountState {
    pub status: ChatGptAccountStatus,
    pub label: Option<String>,
    pub plan_notice_pending: bool,
    pub legacy_prompt_pending: bool,
}

pub struct SignInAttempt {
    pub registration: Value,
    pub discovery: authority::Discovery,
    pub client_id: String,
    pub new_registration: bool,
    pub host_id: String,
    pub verifier: String,
    pub state: String,
    pub nonce: String,
    pub kind: SignInKind,
}

pub struct SignInOutcome {
    pub label: String,
    pub plan_enabled: bool,
}

pub fn label(registration: &Value) -> String {
    ["email", "name"]
        .iter()
        .find_map(|key| registration[*key].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("ChatGPT")
        .to_owned()
}
pub fn plan_enabled(registration: &Value) -> bool {
    registration["scopes"].as_array().is_some_and(|scopes| {
        scopes
            .iter()
            .any(|scope| scope == "chatgpt.tokens.use.direct")
    })
}
pub fn signed_in(registration: &Value) -> bool {
    ["access_token", "refresh_token"]
        .iter()
        .all(|key| registration[*key].as_str().is_some_and(|s| !s.is_empty()))
}

impl ModelConfiguration {
    pub async fn chatgpt_paths(&self) -> Result<store::Paths, Error> {
        let path = self
            .data_root
            .join(butler_platform::data_paths::ENVIRONMENT);
        let private = tokio::task::spawn_blocking(move || {
            butler_core::configuration::read_private_environment(&path)
        })
        .await
        .map_err(|_| "chatgpt_store_unreadable")?
        .map_err(|_| "chatgpt_store_unreadable")?;
        let mut environment = self.environment.clone();
        super::environment::merge_private_auth_environment(&mut environment, &private);
        Ok(store::paths(
            &self.data_root,
            environment.chatgpt_auth_dir.as_deref(),
        ))
    }
    pub fn chatgpt_authority(&self) -> &authority::ChatGptAuthority {
        &self.chatgpt_authority
    }
    pub fn chatgpt_revision(&self) -> tokio::sync::watch::Receiver<u64> {
        self.account_revision.subscribe()
    }
    pub fn chatgpt_changed(&self) {
        self.account_revision
            .send_modify(|value| *value = value.wrapping_add(1));
    }
    pub fn chatgpt_callback_environment(&self) -> (Option<&str>, Option<&str>) {
        (
            self.environment.chatgpt_oauth_port.as_deref(),
            self.environment.oauth_callback_bind_host.as_deref(),
        )
    }
    pub fn chatgpt_no_browser(&self) -> bool {
        self.environment.oauth_no_browser.as_deref() == Some("1")
    }
    pub async fn chatgpt_account(&self) -> Result<ChatGptAccountState, Error> {
        store::account(&self.chatgpt_paths().await?).await
    }
    pub async fn chatgpt_prepare(&self, kind: SignInKind) -> Result<SignInAttempt, Error> {
        let paths = self.chatgpt_paths().await?;
        let host = store::ensure_host(&paths).await?;
        let registration = store::read(&paths.registration).await?;
        let discovery = self.chatgpt_authority.discovery().await?;
        let saved = registration["client_id"]
            .as_str()
            .filter(|id| !id.is_empty());
        let new_registration = kind == SignInKind::NewAccount || saved.is_none();
        Ok(SignInAttempt {
            client_id: if new_registration {
                DYNAMIC_CLIENT.into()
            } else {
                saved.unwrap_or(DYNAMIC_CLIENT).into()
            },
            new_registration,
            registration,
            discovery,
            kind,
            host_id: host["ext_agent_host_id"]
                .as_str()
                .ok_or("oauth_host_unreadable")?
                .into(),
            verifier: super::generate_pkce_verifier(),
            state: super::generate_pkce_verifier(),
            nonce: super::generate_pkce_verifier(),
        })
    }
    pub async fn chatgpt_acknowledge(&self, legacy: bool) -> Result<ChatGptAccountState, Error> {
        let paths = self.chatgpt_paths().await?;
        if legacy {
            store::ensure_host(&paths).await?;
        }
        let path = if legacy {
            paths.host.clone()
        } else {
            paths.registration.clone()
        };
        store::update(&paths, path, move |raw| {
            raw[if legacy {
                "legacy_prompt_acknowledged_at"
            } else {
                "plan_notice_acknowledged_at"
            }] = chrono::Utc::now().to_rfc3339().into();
            Ok(())
        })
        .await?;
        self.chatgpt_changed();
        self.chatgpt_account().await
    }
}

/// Opaque registration identity; never a wire field.
pub fn registration(raw: &Value) -> Option<String> {
    use sha2::{Digest, Sha256};
    let client = raw["client_id"].as_str().filter(|s| !s.is_empty())?;
    let subject = raw["subject"].as_str().filter(|s| !s.is_empty())?;
    Some(format!("{:x}", Sha256::digest(format!("{client}\n{subject}")))[..16].into())
}
