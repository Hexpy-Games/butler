//! Latest subscription quota per provider, from response headers and polls.
//!
//! The provider client reports each response's quota headers here, and the
//! [`ProviderQuotaPoller`] adds readings of the providers' usage endpoints.
//! The store keeps the latest reading per provider, persists it to
//! `metrics/provider-quota.json` so a restart still shows the last known
//! values (marked stale), keeps the outcome of the latest poll in memory, and
//! announces changed views to subscribers.

mod poller;
mod view;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use butler_models::models::{
    ProviderClock, ProviderQuotaReading, ProviderQuotaSink, ProviderQuotaWindow,
};

pub use poller::{ProviderQuotaFetcher, ProviderQuotaPoller, QuotaFetchFuture, QuotaPollTrigger};
pub use view::unavailable_view;

const FILE: &str = "metrics/provider-quota.json";
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

/// Why no (fresh) quota is shown.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct QuotaUnavailableReason {
    /// `provider_quota_pending` (supported, no data yet),
    /// `provider_quota_not_offered` (no quota to read) or
    /// `provider_quota_fetch_failed` (the latest poll failed).
    pub code: String,
    /// Short English explanation; never a provider error text.
    pub message: String,
}

/// One quota window as the App shows it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowView {
    /// `tokens-5-hour`, `tokens-weekly`, `mcp-month`, or
    /// `tokens-primary`/`tokens-secondary`.
    pub id: String,
    /// Share of the window used, 0–100.
    pub used_percent: Option<f64>,
    /// Share of the window left, 0–100.
    pub remaining_percent: Option<f64>,
    /// Window length in minutes.
    pub window_duration_mins: Option<u64>,
    /// When the window resets (RFC 3339).
    pub resets_at: Option<String>,
    /// Always `None`: no source reports an expiry.
    pub expires_at: Option<String>,
}

/// `ProviderQuotaResultView`: the provider's remaining quota.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaView {
    /// Whether a reading exists.
    pub available: bool,
    /// The reading is older than 15 minutes, a window has reset since, or
    /// the latest poll failed after it.
    pub stale: bool,
    /// `zai_usage_query` for Z.AI polls, else `provider_quota`.
    pub source_kind: String,
    /// `<provider>-response-headers`, `<provider>-usage-endpoint` or
    /// `zai-coding-plan-usage-query`.
    pub source_id: String,
    /// Plan kind of the reading.
    pub plan_kind: QuotaPlanKind,
    /// Plan name the provider reported, when known.
    pub plan_name: Option<String>,
    /// Reported windows, primary first.
    pub windows: Vec<QuotaWindowView>,
    /// When the reading was received (RFC 3339).
    pub fetched_at: Option<String>,
    /// Why no fresh quota is shown.
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

/// The outcome of the latest poll of one provider (kept in memory only).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum QuotaPollStatus {
    /// The usage endpoint answered; its reading is the stored one.
    Read,
    /// The provider offers no quota to read.
    NotOffered(QuotaPlanKind),
    /// Supported, but nothing can be read yet (no credential).
    Pending,
    /// The latest poll failed at this time (epoch milliseconds).
    Failed(i64),
    /// Polling is kill-switched for the provider.
    Disabled,
}

#[derive(Default, Deserialize, Serialize)]
struct PersistedQuota {
    providers: BTreeMap<String, ProviderQuotaReading>,
}

/// Process-owned latest quota per provider.
pub struct ProviderQuotaStore {
    path: PathBuf,
    readings: Mutex<BTreeMap<String, ProviderQuotaReading>>,
    statuses: Mutex<BTreeMap<String, QuotaPollStatus>>,
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
            statuses: Mutex::new(BTreeMap::new()),
            updates: broadcast::channel(UPDATE_CAPACITY).0,
            clock,
        }
    }

    /// The provider's quota view: its latest reading, or why there is none.
    pub fn view(&self, provider_id: &str) -> ProviderQuotaView {
        let reading = self.readings.lock().get(provider_id).cloned();
        let status = self.statuses.lock().get(provider_id).copied();
        let now = self.clock.now_epoch_millis();
        reading.map_or_else(
            || view::without_reading(provider_id, status),
            |reading| view::reading_view(&reading, status, now),
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

    /// The outcome of the provider's latest poll, if any.
    pub fn status(&self, provider_id: &str) -> Option<QuotaPollStatus> {
        self.statuses.lock().get(provider_id).copied()
    }

    /// Records a poll that produced no reading; announces a changed view.
    /// When the provider offers nothing to read any more (logged out, or
    /// switched to an API key), its previous reading is dropped: it no
    /// longer describes the account in use.
    pub fn record_status(&self, provider_id: &str, status: QuotaPollStatus) {
        let before = self.view(provider_id);
        self.statuses.lock().insert(provider_id.to_owned(), status);
        if matches!(
            status,
            QuotaPollStatus::NotOffered(_) | QuotaPollStatus::Pending
        ) {
            self.drop_reading(provider_id);
        }
        self.announce_change(provider_id, &before);
    }

    /// Forgets the provider's poll outcome (its kill switch was lifted).
    pub fn clear_status(&self, provider_id: &str) {
        let before = self.view(provider_id);
        self.statuses.lock().remove(provider_id);
        self.announce_change(provider_id, &before);
    }

    fn drop_reading(&self, provider_id: &str) {
        let snapshot = {
            let mut readings = self.readings.lock();
            readings
                .remove(provider_id)
                .is_some()
                .then(|| readings.clone())
        };
        if let Some(readings) = snapshot {
            self.persist(&readings);
        }
    }

    /// Announces the provider's view when what the App shows changed.
    fn announce_change(&self, provider_id: &str, before: &ProviderQuotaView) {
        let after = self.view(provider_id);
        if before.available != after.available
            || before.stale != after.stale
            || before.reason != after.reason
            || before.plan_kind != after.plan_kind
        {
            self.announce(provider_id, after);
        }
    }

    /// Records a polled reading (the poll succeeded).
    pub fn record_polled(&self, reading: ProviderQuotaReading) {
        let provider_id = reading.provider_id.clone();
        let before = self.view(&provider_id);
        self.statuses
            .lock()
            .insert(provider_id.clone(), QuotaPollStatus::Read);
        self.store(reading, &before);
    }

    /// Stores `reading` (keeping a known plan name a header reading lacks);
    /// persists and announces it when the view changed from `before`.
    fn store(&self, mut reading: ProviderQuotaReading, before: &ProviderQuotaView) {
        let provider_id = reading.provider_id.clone();
        let snapshot = {
            let mut readings = self.readings.lock();
            let previous = readings.get(&provider_id);
            if reading.plan_name.is_none() {
                reading.plan_name = previous.and_then(|previous| previous.plan_name.clone());
            }
            let changed = previous.is_none_or(|previous| !same_values(previous, &reading));
            readings.insert(provider_id.clone(), reading);
            changed.then(|| readings.clone())
        };
        if let Some(readings) = &snapshot {
            self.persist(readings);
        }
        let after = self.view(&provider_id);
        if snapshot.is_some() || before.stale != after.stale || before.reason != after.reason {
            self.announce(&provider_id, after);
        }
    }

    fn announce(&self, provider_id: &str, remaining: ProviderQuotaView) {
        let _ = self.updates.send(ProviderQuotaUpdate {
            provider_id: provider_id.to_owned(),
            remaining,
        });
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
        let before = self.view(&reading.provider_id);
        self.store(reading, &before);
    }
}

/// Values the App shows: plan, used share, duration, and reset time to the
/// minute.
fn same_values(left: &ProviderQuotaReading, right: &ProviderQuotaReading) -> bool {
    let key = |window: &ProviderQuotaWindow| {
        (
            window.id.clone(),
            window.used_percent.to_bits(),
            window.window_minutes,
            window.resets_at_ms.map(|ms| ms.div_euclid(60_000)),
        )
    };
    left.plan_name == right.plan_name
        && left.source == right.source
        && left.windows.len() == right.windows.len()
        && left
            .windows
            .iter()
            .map(key)
            .eq(right.windows.iter().map(key))
}

#[cfg(test)]
mod tests;
