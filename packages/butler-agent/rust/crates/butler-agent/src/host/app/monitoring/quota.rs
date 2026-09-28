//! Provider quota polling for the App: the fetcher over the model
//! configuration, its kill switches, and the on-demand refresh waits.
//!
//! Kill switches: `providerQuota.<provider>.polling: false` in
//! `butler.config.json` stops polling one provider (response headers still
//! update its quota); `BUTLER_PROVIDER_QUOTA_POLLING=0` stops all polling
//! (the E2E harness default, so recorded scenarios make no unrecorded
//! requests).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use butler_models::models::{ModelConfiguration, QUOTA_POLLED_PROVIDERS, QuotaHttp};
use butler_runtime::operations::{
    ProviderQuotaFetcher, ProviderQuotaPoller, ProviderQuotaStore, QuotaFetchFuture,
    QuotaPollTrigger,
};

use crate::host::SystemIdentity;

/// How long opening Settings waits for due polls before answering with
/// what the store has; the polls finish in the background.
const SETTINGS_WAIT: Duration = Duration::from_millis(2_500);
/// How long `refresh=1` waits for its poll (above the fetch timeouts).
const EXPLICIT_WAIT: Duration = Duration::from_secs(25);
const POLLING_ENV: &str = "BUTLER_PROVIDER_QUOTA_POLLING";

/// Polls through [`ModelConfiguration::fetch_provider_quota`]; credentials
/// stay in the Models port.
struct ModelQuotaFetcher {
    configuration: Arc<ModelConfiguration>,
    http: QuotaHttp,
    config_path: PathBuf,
    disabled_by_environment: bool,
}

impl ProviderQuotaFetcher for ModelQuotaFetcher {
    fn providers(&self) -> Vec<String> {
        QUOTA_POLLED_PROVIDERS
            .iter()
            .map(|id| (*id).to_owned())
            .collect()
    }

    fn enabled(&self, provider_id: &str) -> bool {
        !self.disabled_by_environment && polling_configured(&self.config_path, provider_id)
    }

    fn refreshes_auth(&self, provider_id: &str) -> bool {
        provider_id == "openai"
    }

    fn fetch<'a>(&'a self, provider_id: &'a str, refresh_auth: bool) -> QuotaFetchFuture<'a> {
        Box::pin(
            self.configuration
                .fetch_provider_quota(provider_id, &self.http, refresh_auth),
        )
    }
}

/// The App's poller, `None` when its HTTP clients cannot be built (quota
/// then comes from response headers only).
pub(super) fn poller(
    configuration: Arc<ModelConfiguration>,
    store: Arc<ProviderQuotaStore>,
    data_root: &Path,
) -> Option<Arc<ProviderQuotaPoller>> {
    let http = QuotaHttp::new(configuration.quota_user_agent()).ok()?;
    let disabled_by_environment =
        std::env::var(POLLING_ENV).is_ok_and(|value| matches!(value.trim(), "0" | "false" | "off"));
    let fetcher = ModelQuotaFetcher {
        configuration,
        http,
        config_path: data_root.join("butler.config.json"),
        disabled_by_environment,
    };
    Some(Arc::new(ProviderQuotaPoller::new(
        store,
        Arc::new(fetcher),
        Arc::new(SystemIdentity),
    )))
}

/// Whether `butler.config.json` leaves polling `provider_id` on (the default).
fn polling_configured(config_path: &Path, provider_id: &str) -> bool {
    let Ok(bytes) = std::fs::read(config_path) else {
        return true;
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|config| {
            config
                .get("providerQuota")?
                .get(provider_id)?
                .get("polling")?
                .as_bool()
        })
        .unwrap_or(true)
}

/// Runs a poll in the background and waits for it at most `wait`.
pub(super) async fn poll_within(
    poller: Arc<ProviderQuotaPoller>,
    trigger: QuotaPollTrigger,
    provider_id: Option<String>,
) {
    let wait = match trigger {
        QuotaPollTrigger::Explicit => EXPLICIT_WAIT,
        QuotaPollTrigger::SettingsOpened | QuotaPollTrigger::Scheduled => SETTINGS_WAIT,
    };
    let task = tokio::spawn(async move { poller.poll(trigger, provider_id.as_deref()).await });
    let _ = tokio::time::timeout(wait, task).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_is_on_unless_the_config_turns_it_off() {
        let dir = std::env::temp_dir().join(format!("butler-quota-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("butler.config.json");
        assert!(polling_configured(&path, "openai"));
        std::fs::write(
            &path,
            r#"{"providerQuota": {"zai": {"polling": false}, "openai": {"polling": true}}}"#,
        )
        .unwrap();
        assert!(!polling_configured(&path, "zai"));
        assert!(polling_configured(&path, "openai"));
        std::fs::write(&path, "not json").unwrap();
        assert!(polling_configured(&path, "zai"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
