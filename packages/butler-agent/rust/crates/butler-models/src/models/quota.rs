//! Subscription quota read from provider responses and usage endpoints.
//!
//! Codex (`x-codex-{primary,secondary}-*`) and Anthropic unified
//! (`anthropic-ratelimit-unified-{5h,7d}-*`) responses report how much of each
//! rolling window is used; Codex logins (`wham/usage`) and the Z.AI Coding
//! Plan (`quota/limit`) also answer a usage endpoint that Butler polls. Only
//! the parsed numbers leave this module; raw header values and bodies are
//! never stored.

mod codex_usage;
mod fetch;
mod lenient;
mod zai_usage;

use butler_core::json::{saturating_i64, saturating_u64};
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};

pub(crate) use codex_usage::parse_codex_usage;
pub use fetch::{QuotaBilling, QuotaFetch, QuotaFetchError, QuotaHttp};
pub(crate) use zai_usage::parse_zai_quota;

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

/// Where a reading came from.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderQuotaSource {
    /// Rate-limit headers of a model response.
    #[default]
    ResponseHeaders,
    /// The provider's usage endpoint, polled by Butler.
    UsageEndpoint,
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
    /// Plan name the provider reported (`plus`, `pro`, `lite`), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_name: Option<String>,
    /// Where the reading came from.
    #[serde(default)]
    pub source: ProviderQuotaSource,
}

/// Whether Butler can read a provider's remaining quota by polling.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuotaSupport {
    /// Butler polls the provider's usage endpoint (Codex logins, the Z.AI
    /// Coding Plan).
    Polled,
    /// The provider offers no quota to read; the value says how it bills.
    NotOffered(QuotaBilling),
}

/// The providers whose usage endpoint Butler polls.
pub const QUOTA_POLLED_PROVIDERS: [&str; 2] = ["openai", "zai"];

/// The static quota support of a provider id. OpenCode Go bills a plan but
/// documents no quota surface, so it is not offered for now.
pub fn provider_quota_support(provider_id: &str) -> QuotaSupport {
    match provider_id {
        _ if QUOTA_POLLED_PROVIDERS.contains(&provider_id) => QuotaSupport::Polled,
        "opencode-go" => QuotaSupport::NotOffered(QuotaBilling::Subscription),
        "anthropic" | "google" | "xai" | "qwen" | "kimi" | "zai-api" => {
            QuotaSupport::NotOffered(QuotaBilling::Api)
        }
        _ => QuotaSupport::NotOffered(QuotaBilling::Unknown),
    }
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
        plan_name: None,
        source: ProviderQuotaSource::ResponseHeaders,
    })
}

/// A Codex window; a zero-minute window is a limit the plan does not have.
fn codex_window(headers: &HeaderMap, slot: &str, now_ms: i64) -> Option<ProviderQuotaWindow> {
    let used = number(headers, &format!("x-codex-{slot}-used-percent"))?;
    let window_minutes = number(headers, &format!("x-codex-{slot}-window-minutes"))
        .map(|minutes| saturating_u64(minutes.round()));
    if window_minutes == Some(0) {
        return None;
    }
    let resets_at_ms = number(headers, &format!("x-codex-{slot}-reset-after-seconds"))
        .map(|seconds| now_ms.saturating_add(saturating_i64((seconds * 1000.0).round())))
        .or_else(|| {
            number(headers, &format!("x-codex-{slot}-reset-at"))
                .map(|seconds| saturating_i64((seconds * 1000.0).round()))
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

/// `tokens-5-hour` / `tokens-weekly` for the known durations, else
/// `tokens-<slot>`.
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
