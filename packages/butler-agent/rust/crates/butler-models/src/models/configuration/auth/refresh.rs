//! A refresh owns its lock until the rotated token is durably published,
//! even if the requesting model call or quota poll is cancelled.
use super::{AuthError, AuthOwner, OpenAiAuthProfile, error};
use std::sync::Arc;

pub(super) async fn once(
    owner: &AuthOwner<'_>,
    profile: OpenAiAuthProfile,
) -> Result<OpenAiAuthProfile, AuthError> {
    let data_root = owner.data_root.to_owned();
    let environment = owner.environment.clone();
    let clock = Arc::clone(owner.clock);
    let client = owner.client.clone();
    tokio::spawn(async move {
        let owner = AuthOwner {
            data_root: &data_root,
            environment: &environment,
            clock: &clock,
            client: &client,
        };
        let _refreshing = butler_core::configuration::lock_file_async(&owner.butler_profile_path())
            .await
            .map_err(|source| {
                if let butler_core::configuration::ConfigError::LockFailed(os) = &source {
                    eprintln!(
                        "[oauth-profile-lock] kind={:?} os_code={:?}",
                        os.kind(),
                        os.raw_os_error()
                    );
                }
                error(
                    "provider_auth_lock_failed",
                    "OpenAI auth profile could not be locked.",
                )
                .with_source(source)
            })?;
        if let Some(current) = owner.read_butler_profile().await
            && !current.access_token.is_empty()
            && (current.access_token != profile.access_token
                || current.refresh_token != profile.refresh_token)
        {
            return Ok(current);
        }
        owner.refresh(profile).await
    })
    .await
    .map_err(|source| {
        error(
            "provider_auth_refresh_failed",
            "OpenAI OAuth refresh failed.",
        )
        .with_source(source)
    })?
}
