//! Latest subscription quota per provider, parsed from successful responses.
//!
//! The provider client reports each response's quota headers here as parsed
//! numbers. The store keeps the latest reading per provider, persists it to
//! `metrics/provider-quota.json` so a restart still shows the last known
//! values (marked stale), and announces changed values to subscribers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use butler_models::models::{
    ProviderClock, ProviderQuotaReading, ProviderQuotaSink, ProviderQuotaWindow,
};

const FILE: &str = "metrics/provider-quota.json";
/// A reading older than this is shown as stale.
const STALE_AFTER_MS: i64 = 15 * 60 * 1000;
const UPDATE_CAPACITY: usize = 64;

/// Whether the quota belongs to a subscription plan or to API billing.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaPlanKind {
    /// A subscription plan (e.g. ChatGPT) with usage windows.
    Subscription,
    /// Pay-per-token API billing.
    Api,
    /// Not reported.
    Unknown,
}

/// Why no quota is shown.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct QuotaUnavailableReason {
    /// Stable code, e.g. `provider_quota_surface_unavailable`.
    pub code: String,
    /// Short English explanation.
    pub message: String,
}

/// One quota window as the App shows it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowView {
    /// `tokens-5-hour`, `tokens-weekly`, or `tokens-primary`/`tokens-secondary`.
    pub id: String,
    /// Share of the window used, 0–100.
    pub used_percent: Option<f64>,
    /// Share of the window left, 0–100.
    pub remaining_percent: Option<f64>,
    /// Window length in minutes.
    pub window_duration_mins: Option<u64>,
    /// When the window resets (RFC 3339).
    pub resets_at: Option<String>,
    /// Always `None`: response headers carry no expiry.
    pub expires_at: Option<String>,
}

/// `ProviderQuotaResultView`: the provider's remaining quota.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaView {
    /// Whether a reading exists.
    pub available: bool,
    /// The reading is older than 15 minutes or a window has reset since.
    pub stale: bool,
    /// Always `provider_quota`: parsed from response headers.
    pub source_kind: String,
    /// `<provider>-response-headers`.
    pub source_id: String,
    /// Plan kind of the reading.
    pub plan_kind: QuotaPlanKind,
    /// Plan name; headers carry none.
    pub plan_name: Option<String>,
    /// Reported windows, primary first.
    pub windows: Vec<QuotaWindowView>,
    /// When the reading was received (RFC 3339).
    pub fetched_at: Option<String>,
    /// Why no quota is shown, when unavailable.
    pub reason: Option<QuotaUnavailableReason>,
}

/// A changed quota, published as the `provider_quota_updated` live event.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderQuotaUpdate {
    /// Provider id, e.g. `openai`.
    pub provider_id: String,
    /// The provider's new quota view.
    pub remaining: ProviderQuotaView,
}

#[derive(Default, Deserialize, Serialize)]
struct PersistedQuota {
    providers: BTreeMap<String, ProviderQuotaReading>,
}

/// Process-owned latest quota per provider.
pub struct ProviderQuotaStore {
    path: PathBuf,
    readings: Mutex<BTreeMap<String, ProviderQuotaReading>>,
    updates: broadcast::Sender<ProviderQuotaUpdate>,
    clock: Arc<dyn ProviderClock>,
}

impl ProviderQuotaStore {
    /// Opens the store, loading the last persisted readings when present.
    pub fn open(data_root: &Path, clock: Arc<dyn ProviderClock>) -> Self {
        let path = data_root.join(FILE);
        let readings = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedQuota>(&bytes).ok())
            .unwrap_or_default()
            .providers;
        Self {
            path,
            readings: Mutex::new(readings),
            updates: broadcast::channel(UPDATE_CAPACITY).0,
            clock,
        }
    }

    /// The provider's quota view: its latest reading, or unavailable.
    pub fn view(&self, provider_id: &str) -> ProviderQuotaView {
        let reading = self.readings.lock().get(provider_id).cloned();
        let now = self.clock.now_epoch_millis();
        reading.map_or_else(
            || unavailable_view(provider_id),
            |reading| reading_view(&reading, now),
        )
    }

    /// Providers with a reading, in id order.
    pub fn provider_ids(&self) -> Vec<String> {
        self.readings.lock().keys().cloned().collect()
    }

    /// Receives every changed quota.
    pub fn subscribe(&self) -> broadcast::Receiver<ProviderQuotaUpdate> {
        self.updates.subscribe()
    }

    fn persist(&self, readings: &BTreeMap<String, ProviderQuotaReading>) {
        let persisted = PersistedQuota {
            providers: readings.clone(),
        };
        // Best effort: the in-memory reading stays authoritative for this process.
        if let Ok(value) = serde_json::to_value(&persisted) {
            let _ = butler_core::configuration::write_json_atomic(&self.path, &value);
        }
    }
}

impl ProviderQuotaSink for ProviderQuotaStore {
    fn observe(&self, reading: ProviderQuotaReading) {
        let provider_id = reading.provider_id.clone();
        let snapshot = {
            let mut readings = self.readings.lock();
            let changed = readings
                .get(&provider_id)
                .is_none_or(|previous| !same_values(previous, &reading));
            readings.insert(provider_id.clone(), reading.clone());
            changed.then(|| readings.clone())
        };
        let Some(readings) = snapshot else {
            return;
        };
        self.persist(&readings);
        let remaining = reading_view(&reading, self.clock.now_epoch_millis());
        let _ = self.updates.send(ProviderQuotaUpdate {
            provider_id,
            remaining,
        });
    }
}

/// Values the App shows: used share, duration, and reset time to the minute.
fn same_values(left: &ProviderQuotaReading, right: &ProviderQuotaReading) -> bool {
    let key = |window: &ProviderQuotaWindow| {
        (
            window.id.clone(),
            window.used_percent.to_bits(),
            window.window_minutes,
            window.resets_at_ms.map(|ms| ms.div_euclid(60_000)),
        )
    };
    left.windows.len() == right.windows.len()
        && left
            .windows
            .iter()
            .map(key)
            .eq(right.windows.iter().map(key))
}

fn reading_view(reading: &ProviderQuotaReading, now_ms: i64) -> ProviderQuotaView {
    let reset_passed = reading
        .windows
        .iter()
        .any(|window| window.resets_at_ms.is_some_and(|reset| reset <= now_ms));
    ProviderQuotaView {
        available: true,
        stale: reset_passed || now_ms - reading.observed_at_ms > STALE_AFTER_MS,
        source_kind: "provider_quota".into(),
        source_id: format!("{}-response-headers", reading.provider_id),
        plan_kind: QuotaPlanKind::Subscription,
        plan_name: None,
        windows: reading.windows.iter().map(window_view).collect(),
        fetched_at: iso(reading.observed_at_ms),
        reason: None,
    }
}

fn window_view(window: &ProviderQuotaWindow) -> QuotaWindowView {
    QuotaWindowView {
        id: window.id.clone(),
        used_percent: Some(window.used_percent),
        remaining_percent: Some((100.0 - window.used_percent).clamp(0.0, 100.0)),
        window_duration_mins: window.window_minutes,
        resets_at: window.resets_at_ms.and_then(iso),
        expires_at: None,
    }
}

/// The view for a provider with no reading yet.
pub fn unavailable_view(provider_id: &str) -> ProviderQuotaView {
    ProviderQuotaView {
        available: false,
        stale: false,
        source_kind: "provider_quota".into(),
        source_id: format!("{provider_id}-response-headers"),
        plan_kind: QuotaPlanKind::Unknown,
        plan_name: None,
        windows: Vec::new(),
        fetched_at: None,
        reason: Some(QuotaUnavailableReason {
            code: "provider_quota_surface_unavailable".into(),
            message: "The provider has not reported quota for this account yet.".into(),
        }),
    }
}

fn iso(epoch_ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(epoch_ms)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
}
