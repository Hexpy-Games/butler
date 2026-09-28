//! Subscription quota read from successful provider responses.
//!
//! Codex (`x-codex-{primary,secondary}-*`) and Anthropic unified
//! (`anthropic-ratelimit-unified-{5h,7d}-*`) responses report how much of each
//! rolling window is used. Only the parsed numbers leave this module; raw
//! header values are never stored.

use butler_core::json::{saturating_i64, saturating_u64};
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};

/// One rolling quota window as the provider reported it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProviderQuotaWindow {
    /// Stable window id: `tokens-5-hour`, `tokens-weekly`, or
    /// `tokens-primary` / `tokens-secondary` for other durations.
    pub id: String,
    /// Share of the window already used, 0–100.
    pub used_percent: f64,
    /// Window length in minutes, when reported.
    pub window_minutes: Option<u64>,
    /// When the window resets (epoch milliseconds), when reported.
    pub resets_at_ms: Option<i64>,
}

/// All quota windows one response reported for a provider.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProviderQuotaReading {
    /// Provider id, e.g. `openai`.
    pub provider_id: String,
    /// Reported windows, primary first.
    pub windows: Vec<ProviderQuotaWindow>,
    /// When the response was received (epoch milliseconds).
    pub observed_at_ms: i64,
}

/// Receives quota readings parsed from successful provider responses.
pub trait ProviderQuotaSink: Send + Sync {
    /// Called once per successful response that carried quota headers.
    fn observe(&self, reading: ProviderQuotaReading);
}

const FIVE_HOURS: u64 = 300;
const ONE_WEEK: u64 = 10_080;

/// Parses the quota headers of one successful response, `None` when it
/// carried none.
pub fn parse_quota_headers(
    provider_id: &str,
    headers: &HeaderMap,
    now_ms: i64,
) -> Option<ProviderQuotaReading> {
    let mut windows = Vec::new();
    for slot in ["primary", "secondary"] {
        if let Some(window) = codex_window(headers, slot, now_ms) {
            windows.push(window);
        }
    }
    for (slot, minutes) in [("5h", FIVE_HOURS), ("7d", ONE_WEEK)] {
        if let Some(window) = anthropic_window(headers, slot, minutes) {
            windows.push(window);
        }
    }
    (!windows.is_empty()).then(|| ProviderQuotaReading {
        provider_id: provider_id.to_owned(),
        windows,
        observed_at_ms: now_ms,
    })
}

fn codex_window(headers: &HeaderMap, slot: &str, now_ms: i64) -> Option<ProviderQuotaWindow> {
    let used = number(headers, &format!("x-codex-{slot}-used-percent"))?;
    let window_minutes = number(headers, &format!("x-codex-{slot}-window-minutes"))
        .filter(|minutes| *minutes > 0.0)
        .map(|minutes| saturating_u64(minutes.round()));
    let resets_at_ms = number(headers, &format!("x-codex-{slot}-reset-at"))
        .map(|seconds| saturating_i64((seconds * 1000.0).round()))
        .or_else(|| {
            number(headers, &format!("x-codex-{slot}-reset-after-seconds"))
                .map(|seconds| now_ms.saturating_add(saturating_i64((seconds * 1000.0).round())))
        });
    Some(ProviderQuotaWindow {
        id: window_id(window_minutes, slot),
        used_percent: used.clamp(0.0, 100.0),
        window_minutes,
        resets_at_ms,
    })
}

/// Anthropic reports utilization as a 0–1 fraction and resets as epoch seconds.
fn anthropic_window(headers: &HeaderMap, slot: &str, minutes: u64) -> Option<ProviderQuotaWindow> {
    let utilization = number(
        headers,
        &format!("anthropic-ratelimit-unified-{slot}-utilization"),
    )?;
    let resets_at_ms = number(
        headers,
        &format!("anthropic-ratelimit-unified-{slot}-reset"),
    )
    .map(|seconds| saturating_i64((seconds * 1000.0).round()));
    Some(ProviderQuotaWindow {
        id: window_id(Some(minutes), slot),
        used_percent: (utilization * 100.0).clamp(0.0, 100.0),
        window_minutes: Some(minutes),
        resets_at_ms,
    })
}

fn window_id(minutes: Option<u64>, slot: &str) -> String {
    match minutes {
        Some(FIVE_HOURS) => "tokens-5-hour".into(),
        Some(ONE_WEEK) => "tokens-weekly".into(),
        _ => format!("tokens-{slot}"),
    }
}

fn number(headers: &HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)?
        .to_str()
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

#[cfg(test)]
mod tests;
