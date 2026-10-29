//! Public inventory of held OAuth credentials; registration secrets never leave this module.
use super::{Error, signed_in, store};
use crate::models::ModelConfiguration;
use serde::Serialize;

#[derive(Serialize)]
pub struct OauthCredential {
    pub id: &'static str,
    pub provider: &'static str,
    pub kind: &'static str,
    pub label: Option<String>,
    pub obtained_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub revocable: bool,
}
#[derive(Serialize)]
pub struct OauthCredentials {
    pub credentials: Vec<OauthCredential>,
}
#[derive(Serialize)]
pub struct RemovedOauthCredential {
    pub removed: bool,
    pub revoked: Option<bool>,
}
impl ModelConfiguration {
    pub async fn oauth_credentials(&self) -> Result<OauthCredentials, Error> {
        let paths = self.chatgpt_paths().await?;
        let raw = store::read(&paths.registration).await?;
        let mut credentials = Vec::new();
        if signed_in(&raw) {
            credentials.push(OauthCredential {
                id: "chatgpt",
                provider: "chatgpt",
                kind: "sign_in",
                label: Some(super::label(&raw)),
                obtained_at: raw["signed_in_at"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|at| at.timestamp()),
                expires_at: None,
                revocable: true,
            });
        }
        if let Some(metadata) = legacy_metadata(&paths).await? {
            credentials.push(OauthCredential {
                id: "chatgpt-legacy",
                provider: "chatgpt",
                kind: "legacy_sign_in",
                label: None,
                obtained_at: metadata
                    .modified()
                    .ok()
                    .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|at| i64::try_from(at.as_secs()).ok()),
                expires_at: None,
                revocable: false,
            });
        }
        Ok(OauthCredentials { credentials })
    }
    pub async fn remove_oauth_credential(&self, id: &str) -> Result<RemovedOauthCredential, Error> {
        let paths = self.chatgpt_paths().await?;
        let revoked = match id {
            "chatgpt" if signed_in(&store::read(&paths.registration).await?) => {
                Some(self.chatgpt_sign_out().await?)
            }
            "chatgpt-legacy" if legacy_metadata(&paths).await?.is_some() => {
                store::remove_legacy(&paths).await?;
                self.chatgpt_changed();
                self.provider_account_changed("openai");
                None
            }
            _ => return Err("credential_not_found"),
        };
        Ok(RemovedOauthCredential {
            removed: true,
            revoked,
        })
    }
}
async fn legacy_metadata(paths: &store::Paths) -> Result<Option<std::fs::Metadata>, Error> {
    match tokio::fs::metadata(&paths.legacy).await {
        Ok(metadata) => Ok((metadata.len() > 0).then_some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("chatgpt_store_unreadable"),
    }
}
