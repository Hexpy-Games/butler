//! Poll cadence, spacing of on-demand polls, backoff, the refresh cap and
//! auth block for rejected tokens, the kill switch and the schema-mismatch
//! counter, against a scripted fetcher.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};

use butler_models::models::{ProviderQuotaSource, QuotaBilling};

use super::super::tests::{Clock, Dir, NOW, reading, store};
use super::*;

const MINUTE: i64 = 60_000;

#[derive(Default)]
struct Scripted {
    results: Mutex<VecDeque<QuotaFetch>>,
    /// `allow_refresh` of every fetch.
    calls: Mutex<Vec<bool>>,
    disabled: AtomicBool,
}

impl Scripted {
    fn push(&self, result: Result<ProviderQuotaReading, QuotaFetchError>) {
        self.results.lock().push_back(result.into());
    }

    /// A 401 that the fetch answered by refreshing the login (and failing).
    fn push_rejected_after_refresh(&self) {
        self.results.lock().push_back(QuotaFetch {
            result: Err(QuotaFetchError::Unauthorized { status: 401 }),
            refreshed_login: true,
        });
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

    fn fetch<'a>(&'a self, _provider_id: &'a str, allow_refresh: bool) -> QuotaFetchFuture<'a> {
        self.calls.lock().push(allow_refresh);
        let fetch = self
            .results
            .lock()
            .pop_front()
            .unwrap_or_else(|| Err(QuotaFetchError::Http { status: 500 }).into());
        Box::pin(async move { fetch })
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

/// Scheduled polls wait 5 minutes after a success; Settings polls are
/// spaced 30 s and explicit ones 20 s apart.
// test-category: pure-logic
#[tokio::test]
async fn each_trigger_keeps_its_spacing() {
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
    // Settings: 30 s after the last attempt.
    h.at(5 * MINUTE + 29_000);
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 2);
    h.at(5 * MINUTE + 30_000);
    h.ok();
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 3);
    // Explicit: 20 s after the last attempt.
    h.at(5 * MINUTE + 49_000);
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls().len(), 3);
    h.at(5 * MINUTE + 50_000);
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls().len(), 4);
}

/// Failures back off 2 → 30 minutes; a rate limit blocks every trigger
/// until its `Retry-After`, capped at an hour.
// test-category: pure-logic
#[tokio::test]
async fn failures_and_rate_limits_back_off() {
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

    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    h.at(MINUTE);
    h.fetcher.push(Err(QuotaFetchError::RateLimited {
        retry_after_ms: Some(5 * 60 * MINUTE),
    }));
    h.poll(QuotaPollTrigger::Explicit).await;
    let view = h.view();
    assert!(view.available && view.stale, "{view:?}");
    assert_eq!(code(&view), Some("provider_quota_fetch_failed"));
    h.at(60 * MINUTE);
    h.poll(QuotaPollTrigger::Explicit).await;
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    assert_eq!(h.fetcher.calls().len(), 2);
    h.at(61 * MINUTE);
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls().len(), 3);
    assert!(!h.view().stale);
}

/// A token the endpoint rejects may be refreshed once per 10 minutes, and a
/// standing rejection stops scheduled and Settings polls: only an explicit
/// refresh polls again.
// test-category: security
#[tokio::test]
async fn rejected_tokens_refresh_rarely_and_block_background_polls() {
    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    h.at(MINUTE);
    h.fetcher.push_rejected_after_refresh();
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls(), [true, true]);
    let view = h.view();
    assert!(view.available && view.stale, "{view:?}");
    assert_eq!(code(&view), Some("provider_quota_fetch_failed"));
    // Background polls stop, even long after the backoff.
    h.at(3 * MINUTE);
    h.poll(QuotaPollTrigger::SettingsOpened).await;
    h.at(60 * MINUTE);
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 2);
    // An explicit poll within 10 minutes of the refresh may not refresh.
    h.at(2 * MINUTE);
    h.fetcher
        .push(Err(QuotaFetchError::Unauthorized { status: 401 }));
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls(), [true, true, false]);
    // Ten minutes after the refresh, it may again; a success unblocks.
    h.at(11 * MINUTE);
    h.ok();
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.fetcher.calls(), [true, true, false, true]);
    assert!(!h.view().stale);
    h.at(16 * MINUTE);
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(h.fetcher.calls().len(), 5);
}

/// Logging out or switching to an API key drops the previous reading and
/// shows the new reason, without backing off.
// test-category: pure-logic
#[tokio::test]
async fn nothing_to_read_replaces_the_reading_with_its_reason() {
    let h = Harness::new();
    h.ok();
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert!(h.view().available);
    h.at(5 * MINUTE);
    h.fetcher
        .push(Err(QuotaFetchError::NotOffered(QuotaBilling::Api)));
    h.poll(QuotaPollTrigger::Scheduled).await;
    let view = h.view();
    assert!(!view.available && view.windows.is_empty(), "{view:?}");
    assert_eq!(code(&view), Some("provider_quota_not_offered"));
    assert_eq!(view.plan_kind, crate::operations::QuotaPlanKind::Api);
    assert!(h.poller.store().provider_ids().is_empty());
    h.at(10 * MINUTE);
    h.fetcher.push(Err(QuotaFetchError::NotConfigured));
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert_eq!(code(&h.view()), Some("provider_quota_pending"));
}

/// Schema mismatches are counted (and logged without bodies).
// test-category: pure-logic
#[tokio::test]
async fn schema_mismatches_are_counted() {
    let h = Harness::new();
    h.fetcher.push(Err(QuotaFetchError::Schema));
    h.poll(QuotaPollTrigger::Explicit).await;
    h.at(MINUTE);
    h.fetcher.push(Err(QuotaFetchError::Schema));
    h.poll(QuotaPollTrigger::Explicit).await;
    assert_eq!(h.poller.schema_mismatches(), 2);
    assert_eq!(code(&h.view()), Some("provider_quota_fetch_failed"));
}

/// A kill-switched provider is never fetched and shows "not offered";
/// lifting the switch makes it pending again.
// test-category: pure-logic
#[tokio::test]
async fn the_kill_switch_stops_polls_and_shows_not_offered() {
    let h = Harness::new();
    h.fetcher.disabled.store(true, Ordering::SeqCst);
    h.poll(QuotaPollTrigger::Explicit).await;
    h.poll(QuotaPollTrigger::Scheduled).await;
    assert!(h.fetcher.calls().is_empty());
    let view = h.view();
    assert_eq!(code(&view), Some("provider_quota_not_offered"));
    assert_eq!(view.plan_kind, crate::operations::QuotaPlanKind::Unknown);
    h.fetcher.disabled.store(false, Ordering::SeqCst);
    h.poller.sync_switches();
    assert_eq!(code(&h.view()), Some("provider_quota_pending"));
}
