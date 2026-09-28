//! Quota views by reason (pending, not offered, fetch failed), polled and
//! header readings in one store, and persistence across a restart.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};

use butler_models::models::{ProviderQuotaSource, ProviderQuotaWindow};

use super::*;

pub(super) const NOW: i64 = 1_790_000_000_000;

pub(super) struct Clock(pub(super) AtomicI64);

impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub(super) struct Dir(pub(super) PathBuf);

impl Dir {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!("butler-quota-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn store(dir: &Dir) -> (Arc<ProviderQuotaStore>, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(NOW)));
    (
        Arc::new(ProviderQuotaStore::open(&dir.0, clock.clone())),
        clock,
    )
}

pub(super) fn reading(
    provider: &str,
    used: f64,
    source: ProviderQuotaSource,
) -> ProviderQuotaReading {
    ProviderQuotaReading {
        provider_id: provider.into(),
        windows: vec![ProviderQuotaWindow {
            id: "tokens-5-hour".into(),
            used_percent: used,
            window_minutes: Some(300),
            resets_at_ms: Some(NOW + 3_600_000),
        }],
        observed_at_ms: NOW,
        plan_name: (source == ProviderQuotaSource::UsageEndpoint).then(|| "plus".into()),
        source,
    }
}

fn code(view: &ProviderQuotaView) -> Option<&str> {
    view.reason.as_ref().map(|reason| reason.code.as_str())
}

#[test]
fn without_a_reading_polled_providers_are_pending_and_api_ones_not_offered() {
    let dir = Dir::new();
    let (store, _) = store(&dir);
    let openai = store.view("openai");
    assert!(!openai.available);
    assert_eq!(code(&openai), Some("provider_quota_pending"));
    assert_eq!(openai.plan_kind, QuotaPlanKind::Unknown);
    let zai_api = store.view("zai-api");
    assert_eq!(code(&zai_api), Some("provider_quota_not_offered"));
    assert_eq!(zai_api.plan_kind, QuotaPlanKind::Api);
    assert_eq!(
        store.view("opencode-go").plan_kind,
        QuotaPlanKind::Subscription
    );
    assert_eq!(unavailable_view("zai"), store.view("zai"));
    assert_eq!(code(&store.view("zai")), Some("provider_quota_pending"));
}

#[test]
fn poll_outcomes_without_a_reading_set_the_reason() {
    let dir = Dir::new();
    let (store, _) = store(&dir);
    store.record_status("openai", QuotaPollStatus::NotOffered(QuotaPlanKind::Api));
    let view = store.view("openai");
    assert_eq!(code(&view), Some("provider_quota_not_offered"));
    assert_eq!(view.plan_kind, QuotaPlanKind::Api);
    store.record_status("zai", QuotaPollStatus::Failed(NOW));
    assert_eq!(
        code(&store.view("zai")),
        Some("provider_quota_fetch_failed")
    );
    store.record_status("zai", QuotaPollStatus::Pending);
    assert_eq!(code(&store.view("zai")), Some("provider_quota_pending"));
}

#[test]
fn a_polled_reading_is_shown_with_its_plan_and_source() {
    let dir = Dir::new();
    let (store, _) = store(&dir);
    let mut updates = store.subscribe();
    store.record_polled(reading("zai", 25.0, ProviderQuotaSource::UsageEndpoint));
    let view = store.view("zai");
    assert!(view.available && !view.stale, "{view:?}");
    assert_eq!(view.source_kind, "zai_usage_query");
    assert_eq!(view.source_id, "zai-coding-plan-usage-query");
    assert_eq!(view.plan_name.as_deref(), Some("plus"));
    assert_eq!(view.windows[0].remaining_percent, Some(75.0));
    assert!(view.reason.is_none());
    assert_eq!(updates.try_recv().unwrap().remaining, view);
    store.record_polled(reading("openai", 5.0, ProviderQuotaSource::UsageEndpoint));
    assert_eq!(store.view("openai").source_id, "openai-usage-endpoint");
}

#[test]
fn a_failed_poll_keeps_the_reading_stale_with_the_fetch_failed_reason() {
    let dir = Dir::new();
    let (store, clock) = store(&dir);
    store.record_polled(reading("openai", 40.0, ProviderQuotaSource::UsageEndpoint));
    let mut updates = store.subscribe();
    clock.0.store(NOW + 60_000, Ordering::SeqCst);
    store.record_status("openai", QuotaPollStatus::Failed(NOW + 60_000));
    let view = store.view("openai");
    assert!(view.available && view.stale, "{view:?}");
    assert_eq!(code(&view), Some("provider_quota_fetch_failed"));
    assert_eq!(view.windows[0].used_percent, Some(40.0));
    assert_eq!(updates.try_recv().unwrap().remaining, view);
    // A repeated failure changes nothing the App shows: no new event.
    store.record_status("openai", QuotaPollStatus::Failed(NOW + 120_000));
    assert!(updates.try_recv().is_err());
    // The next success is fresh again.
    let mut fresh = reading("openai", 41.0, ProviderQuotaSource::UsageEndpoint);
    fresh.observed_at_ms = NOW + 180_000;
    store.record_polled(fresh);
    let view = store.view("openai");
    assert!(!view.stale && view.reason.is_none(), "{view:?}");
}

#[test]
fn header_readings_keep_the_polled_plan_name() {
    let dir = Dir::new();
    let (store, _) = store(&dir);
    store.record_polled(reading("openai", 10.0, ProviderQuotaSource::UsageEndpoint));
    store.observe(reading(
        "openai",
        12.0,
        ProviderQuotaSource::ResponseHeaders,
    ));
    let view = store.view("openai");
    assert_eq!(view.plan_name.as_deref(), Some("plus"));
    assert_eq!(view.source_id, "openai-response-headers");
    assert_eq!(view.windows[0].used_percent, Some(12.0));
}

#[test]
fn readings_survive_a_restart_but_poll_outcomes_do_not() {
    let dir = Dir::new();
    let (store, _) = store(&dir);
    store.record_polled(reading("zai", 30.0, ProviderQuotaSource::UsageEndpoint));
    store.record_status("zai", QuotaPollStatus::Failed(NOW));
    let (reopened, _) = self::store(&dir);
    let view = reopened.view("zai");
    assert!(view.available && !view.stale, "{view:?}");
    assert_eq!(view.plan_name.as_deref(), Some("plus"));
    assert_eq!(reopened.provider_ids(), ["zai"]);
}
