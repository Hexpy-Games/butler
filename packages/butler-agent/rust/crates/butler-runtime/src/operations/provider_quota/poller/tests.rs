//! Poll cadence, backoff, the one-refresh rule for rejected tokens, the kill
//! switch and the schema-mismatch counter, against a scripted fetcher.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};

use butler_models::models::{ProviderQuotaSource, QuotaBilling};

use super::super::tests::{Clock, Dir, NOW, reading, store};
use super::*;

const MINUTE: i64 = 60_000;

#[derive(Default)]
struct Scripted {
    results: Mutex<VecDeque<Result<ProviderQuotaReading, QuotaFetchError>>>,
    calls: Mutex<Vec<bool>>,
    disabled: AtomicBool,
}

impl Scripted {
    fn push(&self, result: Result<ProviderQuotaReading, QuotaFetchError>) {
        self.results.lock().push_back(result);
    }

    fn calls(&self) -> Vec<bool> {
        self.calls.lock().clone()
    }
}

impl ProviderQuotaFetcher for Scripted {
    fn providers(&self) -> Vec<String> {
        vec!["openai".into()]
    }

    fn enabled(&self, _provider_id: &str) -> bool {
        !self.disabled.load(Ordering::SeqCst)
    }

    fn refreshes_auth(&self, provider_id: &str) -> bool {
        provider_id == "openai"
    }

    fn fetch<'a>(&'a self, _provider_id: &'a str, refresh_auth: bool) -> QuotaFetchFuture<'a> {
        self.calls.lock().push(refresh_auth);
        let result = self
            .results
            .lock()
            .pop_front()
            .unwrap_or(Err(QuotaFetchError::Http { status: 500 }));
        Box::pin(async move { result })
    }
}

struct Harness {
    _dir: Dir,
    clock: Arc<Clock>,
    fetcher: Arc<Scripted>,
    poller: ProviderQuotaPoller,
}

impl Harness {
    fn new() -> Self {
        let dir = Dir::new();
        let (store, clock) = store(&dir);
        let fetcher = Arc::new(Scripted::default());
        let poller = ProviderQuotaPoller::new(store, fetcher.clone(), clock.clone());
        Self {
            _dir: dir,
            clock,
            fetcher,
            poller,
        }
    }

    fn at(&self, offset_ms: i64) {
        self.clock.0.store(NOW + offset_ms, Ordering::SeqCst);
    }

    async fn poll(&self, trigger: QuotaPollTrigger) {
        self.poller.poll(trigger, None).await;
    }

    fn view(&self) -> crate::operations::ProviderQuotaView {
        self.poller.store().view("openai")
    }

    /// Scripts a successful poll observed now.
    fn ok(&self) {
        let now = self.clock.0.load(Ordering::SeqCst);
        let mut reading = reading("openai", 10.0, ProviderQuotaSource::UsageEndpoint);
        reading.observed_at_ms = now;
        reading.windows[0].resets_at_ms = Some(now + 60 * MINUTE);
        self.fetcher.push(Ok(reading));
    }
}

fn code(view: &crate::operations::ProviderQuotaView) -> Option<&str> {
    view.reason.as_ref().map(|reason| reason.code.as_str())
}

#[tokio::test]
async fn a_success_is_polled_again_after_five_minutes_on_schedule() {
    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert!(h.view().available);
    h.at(4 * MINUTE);
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 1);
    h.at(5 * MINUTE);
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 2);
}

#[tokio::test]
async fn settings_polls_are_debounced_and_explicit_ones_are_not() {
    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    h.at(10_000);
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 1);
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls().len(), 2);
    h.at(45_000);
    h.ok();
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 3);
}

#[tokio::test]
async fn failures_back_off_from_two_to_thirty_minutes() {
    let h = Harness::new();
    let mut now = 0;
    let mut delays = Vec::new();
    for _ in 0..6 {
        h.at(now);
        h.poll(QuotaPollTrigger::Scheduled).await;
        let due = h.poller.schedules.lock()["openai"].next_due_ms - NOW;
        delays.push((due - now) / MINUTE);
        now = due;
    }
    assert_eq!(delays, [2, 4, 8, 16, 30, 30]);
    assert_eq!(code(&h.view()), Some("provider_quota_fetch_failed"));
    // Before the backoff ends a scheduled poll does nothing.
    h.at(now - 1);
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 6);
}

#[tokio::test]
async fn a_rate_limit_blocks_every_trigger_until_retry_after() {
    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    h.fetcher.push(Err(QuotaFetchError::RateLimited {
        retry_after_ms: Some(10 * MINUTE),
    }));
    h.poll(QuotaPollTrigger::Explicit).await;
    let view = h.view();
    assert!(view.available && view.stale, "{view:?}");
    assert_eq!(code(&view), Some("provider_quota_fetch_failed"));
    h.at(9 * MINUTE);
    h.poll(QuotaPollTrigger::Explicit).await;
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 2);
    h.at(10 * MINUTE);
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls().len(), 3);
    assert!(!h.view().stale);
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_once_then_polled_only_on_demand() {
    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    for _ in 0..2 {
        h.fetcher
            .push(Err(QuotaFetchError::Unauthorized { status: 401 }));
    }
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls(), [false, false, true]);
    let view = h.view();
    assert!(view.available && view.stale, "{view:?}");
    assert_eq!(code(&view), Some("provider_quota_fetch_failed"));
    // Scheduled polls stop, even long after the backoff.
    h.at(3 * 60 * MINUTE);
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 3);
    // Opening Settings polls again; a success resumes the schedule.
    h.ok();
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 4);
    assert!(!h.view().stale);
    h.at(3 * 60 * MINUTE + 5 * MINUTE);
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 5);
}

#[tokio::test]
async fn a_refresh_that_succeeds_needs_no_on_demand_poll() {
    let h = Harness::new();
    h.fetcher
        .push(Err(QuotaFetchError::Unauthorized { status: 401 }));
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls(), [false, true]);
    assert!(h.view().available && !h.view().stale);
}

#[tokio::test]
async fn nothing_to_read_sets_pending_or_not_offered_without_backoff() {
    let h = Harness::new();
    h.fetcher.push(Err(QuotaFetchError::NotConfigured));
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(code(&h.view()), Some("provider_quota_pending"));
    h.at(5 * MINUTE);
    h.fetcher
        .push(Err(QuotaFetchError::NotOffered(QuotaBilling::Api)));
    h.poll(QuotaPollTrigger::Scheduled).await;
    let view = h.view();
    assert_eq!(code(&view), Some("provider_quota_not_offered"));
    assert_eq!(view.plan_kind, crate::operations::QuotaPlanKind::Api);
}

#[tokio::test]
async fn schema_mismatches_are_counted() {
    let h = Harness::new();
    h.fetcher.push(Err(QuotaFetchError::Schema));
    h.poll(QuotaPollTrigger::Explicit).await;
    h.fetcher.push(Err(QuotaFetchError::Schema));
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.poller.schema_mismatches(), 2);
    assert_eq!(code(&h.view()), Some("provider_quota_fetch_failed"));
}

#[tokio::test]
async fn the_kill_switch_stops_every_trigger() {
    let h = Harness::new();
    h.fetcher.disabled.store(true, Ordering::SeqCst);
    h.poll(QuotaPollTrigger::Explicit).await;
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert!(h.fetcher.calls().is_empty());
    assert_eq!(code(&h.view()), Some("provider_quota_pending"));
    h.poller.poll(QuotaPollTrigger::Explicit, Some("zai")).await;
    assert!(h.fetcher.calls().is_empty());
}
