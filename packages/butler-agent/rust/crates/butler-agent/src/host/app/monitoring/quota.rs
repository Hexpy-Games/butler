//! Provider quota polling for the App: the fetcher over the model
//! configuration, its kill switches, and the on-demand refresh waits.
//!
//! Kill switches: `providerQuota.<provider>.polling: false` in
//! `butler.config.json` stops polling one provider (response headers still
//! update its quota); `BUTLER_PROVIDER_QUOTA_POLLING=0` stops all polling
//! (the E2E harness default, so recorded scenarios make no unrecorded
//! requests).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use butler_models::models::{ModelConfiguration, QUOTA_POLLED_PROVIDERS, QuotaHttp};
use butler_runtime::operations::{
    ProviderQuotaFetcher, ProviderQuotaPoller, ProviderQuotaStore, QuotaFetchFuture,
    QuotaPollStatus, QuotaPollTrigger,
};

use crate::host::SystemIdentity;

/// How long `refresh=1` waits for its poll (above the fetch timeouts).
const EXPLICIT_WAIT: Duration = Duration::from_secs(25);
const POLLING_ENV: &str = "BUTLER_PROVIDER_QUOTA_POLLING";

/// Polls through [`ModelConfiguration::fetch_provider_quota`]; credentials
/// stay in the Models port.
struct ModelQuotaFetcher {
    configuration: Arc<ModelConfiguration>,
    http: QuotaHttp,
    disabled_by_environment: bool,
}

impl ProviderQuotaFetcher for ModelQuotaFetcher {
    fn changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        Some(self.configuration.quota_configuration_changes())
    }
    fn providers(&self) -> Vec<String> {
        self.configuration
            .quota_providers()
            .into_iter()
            .filter(|id| QUOTA_POLLED_PROVIDERS.contains(&id.as_str()))
            .collect()
    }

    fn enabled(&self, provider_id: &str) -> bool {
        !self.disabled_by_environment && self.configuration.quota_polling_enabled(provider_id)
    }

    fn fetch<'a>(&'a self, provider_id: &'a str, allow_refresh: bool) -> QuotaFetchFuture<'a> {
        Box::pin(
            self.configuration
                .fetch_provider_quota(provider_id, &self.http, allow_refresh),
        )
    }
}

/// The App's poller, `None` when its HTTP clients cannot be built (quota
/// then comes from response headers only).
pub(super) fn poller(
    configuration: Arc<ModelConfiguration>,
    store: Arc<ProviderQuotaStore>,
    _data_root: &Path,
) -> Option<Arc<ProviderQuotaPoller>> {
    let http = QuotaHttp::new(configuration.quota_user_agent()).ok()?;
    let disabled_by_environment =
        std::env::var(POLLING_ENV).is_ok_and(|value| matches!(value.trim(), "0" | "false" | "off"));
    let fetcher = ModelQuotaFetcher {
        configuration,
        http,
        disabled_by_environment,
    };
    Some(Arc::new(ProviderQuotaPoller::new(
        store,
        Arc::new(fetcher),
        Arc::new(SystemIdentity),
    )))
}

/// Starts the due polls without waiting for them.
pub(super) fn poll_in_background(poller: Arc<ProviderQuotaPoller>, trigger: QuotaPollTrigger) {
    tokio::spawn(async move { poller.poll(trigger, None).await });
}

/// Runs an explicit poll (`refresh=1`) and waits for it.
pub(super) async fn poll_explicit(poller: Arc<ProviderQuotaPoller>, provider_id: String) {
    let task = tokio::spawn(async move {
        poller
            .poll(QuotaPollTrigger::Explicit, Some(provider_id.as_str()))
            .await;
    });
    let _ = tokio::time::timeout(EXPLICIT_WAIT, task).await;
}

/// Preserve explicit kill-switch semantics even when the provider has no registered model.
pub(super) fn sync_switch(
    configuration: &ModelConfiguration,
    store: &ProviderQuotaStore,
    provider: &str,
) {
    if !QUOTA_POLLED_PROVIDERS.contains(&provider) {
        return;
    }
    let environment_off =
        std::env::var(POLLING_ENV).is_ok_and(|value| matches!(value.trim(), "0" | "false" | "off"));
    let disabled = environment_off || !configuration.quota_polling_configured(provider);
    let marked = store.status(provider) == Some(QuotaPollStatus::Disabled);
    if disabled && !marked {
        store.record_status(provider, QuotaPollStatus::Disabled);
    } else if !disabled && marked {
        store.clear_status(provider);
    }
}
