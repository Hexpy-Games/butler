//! When Butler polls the providers' usage endpoints, and what a poll's
//! outcome does to the store.
//!
//! Cadence:
//! - `Scheduled` (every tick while an App client is connected): each provider
//!   at most every 5 minutes after a success.
//! - `SettingsOpened`: at most once per 30 seconds per provider.
//! - `Explicit` (`GET /provider-quota?refresh=1`): always.
//!
//! Failures back off 2 minutes, doubling per consecutive failure up to 30
//! minutes (at least the provider's `Retry-After`); no trigger polls a
//! provider during a rate-limit backoff. A rejected token gets one login
//! refresh and retry; if that is rejected too, only an on-demand trigger
//! polls the provider again. The latest reading is kept through failures
//! (shown stale). Errors are logged by code only: never bodies or tokens.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

use butler_models::models::{ProviderClock, ProviderQuotaReading, QuotaFetchError};

use super::{ProviderQuotaStore, QuotaPollStatus, view};

const SUCCESS_INTERVAL_MS: i64 = 5 * 60 * 1000;
const SETTINGS_DEBOUNCE_MS: i64 = 30 * 1000;
const FIRST_BACKOFF_MS: i64 = 2 * 60 * 1000;
const MAX_BACKOFF_MS: i64 = 30 * 60 * 1000;

/// One poll's result.
pub type QuotaFetchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProviderQuotaReading, QuotaFetchError>> + Send + 'a>>;

/// Reads providers' quota from their usage endpoints. The host implements it
/// over the model configuration, so credentials stay behind it.
pub trait ProviderQuotaFetcher: Send + Sync {
    /// Providers whose usage endpoint Butler polls, e.g. `openai`, `zai`.
    fn providers(&self) -> Vec<String>;
    /// Whether polling `provider_id` is enabled (the per-provider kill switch).
    fn enabled(&self, provider_id: &str) -> bool;
    /// Whether a rejected token of `provider_id` can be refreshed and retried.
    fn refreshes_auth(&self, provider_id: &str) -> bool;
    /// One poll; `refresh_auth` refreshes the login first.
    fn fetch<'a>(&'a self, provider_id: &'a str, refresh_auth: bool) -> QuotaFetchFuture<'a>;
}

/// What asked for a poll.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuotaPollTrigger {
    /// The periodic poll while an App client is connected.
    Scheduled,
    /// The Settings usage page opened.
    SettingsOpened,
    /// `GET /provider-quota?refresh=1`.
    Explicit,
}

/// Per-provider poll bookkeeping.
#[derive(Clone, Copy, Debug, Default)]
struct Schedule {
    next_due_ms: i64,
    last_attempt_ms: Option<i64>,
    failures: u32,
    rate_limited_until_ms: i64,
    auth_blocked: bool,
}

impl Schedule {
    fn due(&self, trigger: QuotaPollTrigger, now_ms: i64) -> bool {
        if now_ms < self.rate_limited_until_ms {
            return false;
        }
        match trigger {
            QuotaPollTrigger::Scheduled => !self.auth_blocked && now_ms >= self.next_due_ms,
            QuotaPollTrigger::SettingsOpened => self
                .last_attempt_ms
                .is_none_or(|at| now_ms - at >= SETTINGS_DEBOUNCE_MS),
            QuotaPollTrigger::Explicit => true,
        }
    }

    /// Backs off after a failure; returns the delay.
    fn fail(&mut self, now_ms: i64, at_least_ms: i64) -> i64 {
        self.failures = self.failures.saturating_add(1);
        let doublings = self.failures.saturating_sub(1).min(8);
        let delay = (FIRST_BACKOFF_MS << doublings)
            .min(MAX_BACKOFF_MS)
            .max(at_least_ms);
        self.next_due_ms = now_ms.saturating_add(delay);
        delay
    }
}

/// Polls provider usage endpoints into a [`ProviderQuotaStore`].
pub struct ProviderQuotaPoller {
    store: Arc<ProviderQuotaStore>,
    fetcher: Arc<dyn ProviderQuotaFetcher>,
    clock: Arc<dyn ProviderClock>,
    schedules: Mutex<BTreeMap<String, Schedule>>,
    /// One poll at a time, so triggers never fetch a provider twice at once.
    polling: tokio::sync::Mutex<()>,
    schema_mismatches: AtomicU64,
}

impl ProviderQuotaPoller {
    /// A poller writing to `store`.
    pub fn new(
        store: Arc<ProviderQuotaStore>,
        fetcher: Arc<dyn ProviderQuotaFetcher>,
        clock: Arc<dyn ProviderClock>,
    ) -> Self {
        Self {
            store,
            fetcher,
            clock,
            schedules: Mutex::new(BTreeMap::new()),
            polling: tokio::sync::Mutex::new(()),
            schema_mismatches: AtomicU64::new(0),
        }
    }

    /// The store polls write to.
    pub fn store(&self) -> &Arc<ProviderQuotaStore> {
        &self.store
    }

    /// Polls every provider (or only `provider_id`) that `trigger` makes due.
    pub async fn poll(&self, trigger: QuotaPollTrigger, provider_id: Option<&str>) {
        let _polling = self.polling.lock().await;
        for provider in self.fetcher.providers() {
            if provider_id.is_some_and(|only| only != provider) || !self.fetcher.enabled(&provider)
            {
                continue;
            }
            let now = self.clock.now_epoch_millis();
            let due = self
                .schedules
                .lock()
                .get(&provider)
                .copied()
                .unwrap_or_default()
                .due(trigger, now);
            if due {
                self.poll_one(&provider, now).await;
            }
        }
    }

    /// Schema mismatches seen since start (logged, never shown).
    pub fn schema_mismatches(&self) -> u64 {
        self.schema_mismatches.load(Ordering::Relaxed)
    }

    async fn poll_one(&self, provider: &str, now: i64) {
        self.schedules
            .lock()
            .entry(provider.to_owned())
            .or_default()
            .last_attempt_ms = Some(now);
        let mut result = self.fetcher.fetch(provider, false).await;
        if matches!(result, Err(QuotaFetchError::Unauthorized { .. }))
            && self.fetcher.refreshes_auth(provider)
        {
            result = self.fetcher.fetch(provider, true).await;
        }
        let finished = self.clock.now_epoch_millis();
        match result {
            Ok(reading) => self.succeeded(provider, reading, finished),
            Err(error) => self.failed(provider, &error, finished),
        }
    }

    fn succeeded(&self, provider: &str, reading: ProviderQuotaReading, now: i64) {
        self.schedules.lock().insert(
            provider.to_owned(),
            Schedule {
                next_due_ms: now.saturating_add(SUCCESS_INTERVAL_MS),
                last_attempt_ms: Some(now),
                ..Schedule::default()
            },
        );
        self.store.record_polled(reading);
    }

    fn failed(&self, provider: &str, error: &QuotaFetchError, now: i64) {
        let status = match error {
            QuotaFetchError::NotOffered(billing) => {
                QuotaPollStatus::NotOffered(view::plan_kind(*billing))
            }
            QuotaFetchError::NotConfigured => QuotaPollStatus::Pending,
            _ => QuotaPollStatus::Failed(now),
        };
        {
            let mut schedules = self.schedules.lock();
            let schedule = schedules.entry(provider.to_owned()).or_default();
            if let QuotaPollStatus::Failed(_) = status {
                self.back_off(provider, schedule, error, now);
            } else {
                // Nothing to read: look again at the normal cadence.
                *schedule = Schedule {
                    next_due_ms: now.saturating_add(SUCCESS_INTERVAL_MS),
                    last_attempt_ms: schedule.last_attempt_ms,
                    ..Schedule::default()
                };
            }
        }
        self.store.record_status(provider, status);
    }

    fn back_off(&self, provider: &str, schedule: &mut Schedule, error: &QuotaFetchError, now: i64) {
        let retry_after = match error {
            QuotaFetchError::RateLimited { retry_after_ms } => retry_after_ms.unwrap_or(0),
            _ => 0,
        };
        let delay = schedule.fail(now, retry_after);
        if matches!(error, QuotaFetchError::RateLimited { .. }) {
            schedule.rate_limited_until_ms = now.saturating_add(delay);
        }
        if matches!(error, QuotaFetchError::Unauthorized { .. }) {
            schedule.auth_blocked = true;
        }
        match error {
            QuotaFetchError::Schema => {
                let count = self.schema_mismatches.fetch_add(1, Ordering::Relaxed) + 1;
                eprintln!("[provider-quota] provider={provider} schema_mismatch count={count}");
            }
            QuotaFetchError::Http { status } | QuotaFetchError::Unauthorized { status } => {
                eprintln!(
                    "[provider-quota] provider={provider} failed={} status={status} retry_in_ms={delay}",
                    error.code()
                );
            }
            _ => eprintln!(
                "[provider-quota] provider={provider} failed={} retry_in_ms={delay}",
                error.code()
            ),
        }
    }
}

#[cfg(test)]
mod tests;
