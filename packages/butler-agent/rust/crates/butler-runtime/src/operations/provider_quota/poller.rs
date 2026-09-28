//! When Butler polls the providers' usage endpoints, and what a poll's
//! outcome does to the store.
//!
//! Cadence, per provider:
//! - `Scheduled` (every tick while an App client is connected): 5 minutes
//!   after a success.
//! - `SettingsOpened`: at most every 30 seconds.
//! - `Explicit` (`GET /provider-quota?refresh=1`): at most every 20 seconds.
//!
//! Failures back off 2 minutes, doubling per consecutive failure up to 30
//! minutes (at least the provider's `Retry-After`, itself capped at an
//! hour); no trigger polls a provider during a rate-limit backoff. A token
//! the endpoint rejects (HTTP 401) is refreshed at most once per 10 minutes;
//! once a rejection stands, only `Explicit` polls the provider again. A
//! kill-switched provider is not polled and shows "not offered" until it has
//! a reading. The latest reading is kept through failures (shown stale).
//! Errors are logged by code only: never bodies or tokens.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

use butler_models::models::{ProviderClock, ProviderQuotaReading, QuotaFetch, QuotaFetchError};

use super::{ProviderQuotaStore, QuotaPollStatus, view};

const SUCCESS_INTERVAL_MS: i64 = 5 * 60 * 1000;
const SETTINGS_SPACING_MS: i64 = 30 * 1000;
const EXPLICIT_SPACING_MS: i64 = 20 * 1000;
const REFRESH_SPACING_MS: i64 = 10 * 60 * 1000;
const FIRST_BACKOFF_MS: i64 = 2 * 60 * 1000;
const MAX_BACKOFF_MS: i64 = 30 * 60 * 1000;
const MAX_RETRY_AFTER_MS: i64 = 60 * 60 * 1000;

/// One poll's result.
pub type QuotaFetchFuture<'a> = Pin<Box<dyn Future<Output = QuotaFetch> + Send + 'a>>;

/// Reads providers' quota from their usage endpoints. The host implements it
/// over the model configuration, so credentials stay behind it.
pub trait ProviderQuotaFetcher: Send + Sync {
    /// Providers whose usage endpoint Butler polls, e.g. `openai`, `zai`.
    fn providers(&self) -> Vec<String>;
    /// Whether polling `provider_id` is enabled (the per-provider kill switch).
    fn enabled(&self, provider_id: &str) -> bool;
    /// One poll; `allow_refresh` lets a rejected token be refreshed once.
    fn fetch<'a>(&'a self, provider_id: &'a str, allow_refresh: bool) -> QuotaFetchFuture<'a>;
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
    last_refresh_ms: Option<i64>,
    failures: u32,
    rate_limited_until_ms: i64,
    auth_blocked: bool,
}

impl Schedule {
    fn due(&self, trigger: QuotaPollTrigger, now_ms: i64) -> bool {
        let spaced = |spacing: i64| self.last_attempt_ms.is_none_or(|at| now_ms - at >= spacing);
        if now_ms < self.rate_limited_until_ms {
            return false;
        }
        match trigger {
            QuotaPollTrigger::Scheduled => !self.auth_blocked && now_ms >= self.next_due_ms,
            QuotaPollTrigger::SettingsOpened => !self.auth_blocked && spaced(SETTINGS_SPACING_MS),
            QuotaPollTrigger::Explicit => spaced(EXPLICIT_SPACING_MS),
        }
    }

    fn refresh_allowed(&self, now_ms: i64) -> bool {
        self.last_refresh_ms
            .is_none_or(|at| now_ms - at >= REFRESH_SPACING_MS)
    }

    /// Backs off after a failure; returns the delay.
    fn fail(&mut self, now_ms: i64, at_least_ms: i64) -> i64 {
        self.failures = self.failures.saturating_add(1);
        let doublings = self.failures.saturating_sub(1).min(8);
        let delay = (FIRST_BACKOFF_MS << doublings)
            .min(MAX_BACKOFF_MS)
            .max(at_least_ms.min(MAX_RETRY_AFTER_MS));
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

    /// Records which providers are kill-switched, so their views say so.
    pub fn sync_switches(&self) {
        for provider in self.fetcher.providers() {
            let disabled = !self.fetcher.enabled(&provider);
            let marked = self.store.status(&provider) == Some(QuotaPollStatus::Disabled);
            if disabled && !marked {
                self.store
                    .record_status(&provider, QuotaPollStatus::Disabled);
            } else if !disabled && marked {
                self.store.clear_status(&provider);
            }
        }
    }

    /// Polls every provider (or only `provider_id`) that `trigger` makes due.
    pub async fn poll(&self, trigger: QuotaPollTrigger, provider_id: Option<&str>) {
        let _polling = self.polling.lock().await;
        self.sync_switches();
        for provider in self.fetcher.providers() {
            if provider_id.is_some_and(|only| only != provider) || !self.fetcher.enabled(&provider)
            {
                continue;
            }
            let now = self.clock.now_epoch_millis();
            let schedule = self
                .schedules
                .lock()
                .get(&provider)
                .copied()
                .unwrap_or_default();
            if schedule.due(trigger, now) {
                self.poll_one(&provider, now, schedule.refresh_allowed(now))
                    .await;
            }
        }
    }

    /// Schema mismatches seen since start (logged, never shown).
    pub fn schema_mismatches(&self) -> u64 {
        self.schema_mismatches.load(Ordering::Relaxed)
    }

    async fn poll_one(&self, provider: &str, now: i64, allow_refresh: bool) {
        self.schedules
            .lock()
            .entry(provider.to_owned())
            .or_default()
            .last_attempt_ms = Some(now);
        let fetch = self.fetcher.fetch(provider, allow_refresh).await;
        let finished = self.clock.now_epoch_millis();
        if fetch.refreshed_login {
            self.schedules
                .lock()
                .entry(provider.to_owned())
                .or_default()
                .last_refresh_ms = Some(finished);
        }
        match fetch.result {
            Ok(reading) => self.succeeded(provider, reading, finished),
            Err(error) => self.failed(provider, &error, finished),
        }
    }

    fn succeeded(&self, provider: &str, reading: ProviderQuotaReading, now: i64) {
        {
            let mut schedules = self.schedules.lock();
            let schedule = schedules.entry(provider.to_owned()).or_default();
            *schedule = Schedule {
                next_due_ms: now.saturating_add(SUCCESS_INTERVAL_MS),
                last_attempt_ms: schedule.last_attempt_ms,
                last_refresh_ms: schedule.last_refresh_ms,
                ..Schedule::default()
            };
        }
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
                    last_refresh_ms: schedule.last_refresh_ms,
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
pub(super) mod tests;
