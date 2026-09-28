//! The ChatGPT `GET /backend-api/wham/usage` reply of a Codex login.
//!
//! Shape (openai/codex `RateLimitStatusPayload`): `plan_type`, `rate_limit`
//! and `additional_rate_limits[].rate_limit`, each with `allowed` and a
//! `primary_window` / `secondary_window` of `used_percent`,
//! `limit_window_seconds`, `reset_after_seconds` and `reset_at` (epoch
//! seconds). Parsing is lenient: camelCase aliases, `resets_at`, minute
//! durations and numeric strings are accepted. Additional limits merge into
//! the main windows (the most used wins), and a limit with `allowed: false`
//! counts as fully used.

use butler_core::json::{saturating_i64, saturating_u64};
use serde::Deserialize;

use super::fetch::QuotaFetchError;
use super::lenient;
use super::{ProviderQuotaReading, ProviderQuotaSource, ProviderQuotaWindow, window_id};

#[derive(Deserialize)]
struct UsagePayload {
    #[serde(default, alias = "planType", deserialize_with = "lenient::text")]
    plan_type: Option<String>,
    #[serde(default, alias = "rateLimit")]
    rate_limit: Option<RateLimit>,
    #[serde(default, alias = "additionalRateLimits")]
    additional_rate_limits: Option<Vec<AdditionalRateLimit>>,
}

#[derive(Deserialize)]
struct AdditionalRateLimit {
    #[serde(default, alias = "rateLimit")]
    rate_limit: Option<RateLimit>,
}

#[derive(Deserialize)]
struct RateLimit {
    #[serde(default)]
    allowed: Option<bool>,
    #[serde(default, alias = "primaryWindow", alias = "primary")]
    primary_window: Option<Window>,
    #[serde(default, alias = "secondaryWindow", alias = "secondary")]
    secondary_window: Option<Window>,
}

#[derive(Deserialize)]
struct Window {
    #[serde(default, alias = "usedPercent", deserialize_with = "lenient::number")]
    used_percent: Option<f64>,
    #[serde(
        default,
        alias = "limitWindowSeconds",
        alias = "window_seconds",
        alias = "windowSeconds",
        deserialize_with = "lenient::number"
    )]
    limit_window_seconds: Option<f64>,
    #[serde(
        default,
        alias = "limitWindowMinutes",
        alias = "window_minutes",
        alias = "windowMinutes",
        deserialize_with = "lenient::number"
    )]
    limit_window_minutes: Option<f64>,
    #[serde(
        default,
        alias = "resetAfterSeconds",
        alias = "resets_after_seconds",
        deserialize_with = "lenient::number"
    )]
    reset_after_seconds: Option<f64>,
    #[serde(
        default,
        alias = "resetAt",
        alias = "resets_at",
        alias = "resetsAt",
        deserialize_with = "lenient::number"
    )]
    reset_at: Option<f64>,
}

/// Parses a `wham/usage` body into a reading for `provider_id`.
pub(crate) fn parse_codex_usage(
    provider_id: &str,
    body: &[u8],
    now_ms: i64,
) -> Result<ProviderQuotaReading, QuotaFetchError> {
    let payload: UsagePayload =
        serde_json::from_slice(body).map_err(|_| QuotaFetchError::Schema)?;
    let limits = payload.rate_limit.iter().chain(
        payload
            .additional_rate_limits
            .iter()
            .flatten()
            .filter_map(|limit| limit.rate_limit.as_ref()),
    );
    let mut windows: Vec<ProviderQuotaWindow> = Vec::new();
    for limit in limits {
        let exhausted = limit.allowed == Some(false);
        for (slot, window) in [
            ("primary", &limit.primary_window),
            ("secondary", &limit.secondary_window),
        ] {
            if let Some(window) = window
                .as_ref()
                .and_then(|window| codex_window(window, slot, exhausted, now_ms))
            {
                merge(&mut windows, window);
            }
        }
    }
    let plan_name = lenient::plan_name(payload.plan_type.as_deref());
    if windows.is_empty() && plan_name.is_none() {
        return Err(QuotaFetchError::Schema);
    }
    Ok(ProviderQuotaReading {
        provider_id: provider_id.to_owned(),
        windows,
        observed_at_ms: now_ms,
        plan_name,
        source: ProviderQuotaSource::UsageEndpoint,
    })
}

/// One window; a zero-length window is a limit the plan does not have.
fn codex_window(
    window: &Window,
    slot: &str,
    exhausted: bool,
    now_ms: i64,
) -> Option<ProviderQuotaWindow> {
    let used = window.used_percent?;
    let minutes = window
        .limit_window_minutes
        .or_else(|| {
            window
                .limit_window_seconds
                .map(|seconds| (seconds / 60.0).ceil())
        })
        .filter(|minutes| *minutes >= 0.0)
        .map(|minutes| saturating_u64(minutes.round()));
    if minutes == Some(0) {
        return None;
    }
    let resets_at_ms = window.reset_at.and_then(lenient::epoch_millis).or_else(|| {
        window
            .reset_after_seconds
            .filter(|seconds| *seconds >= 0.0)
            .map(|seconds| now_ms.saturating_add(saturating_i64((seconds * 1000.0).round())))
    });
    Some(ProviderQuotaWindow {
        id: window_id(minutes, slot),
        used_percent: if exhausted {
            100.0
        } else {
            used.clamp(0.0, 100.0)
        },
        window_minutes: minutes,
        resets_at_ms,
    })
}

/// Adds `window`, or keeps the more used of it and the same-id window.
fn merge(windows: &mut Vec<ProviderQuotaWindow>, window: ProviderQuotaWindow) {
    match windows.iter_mut().find(|existing| existing.id == window.id) {
        Some(existing) if window.used_percent > existing.used_percent => *existing = window,
        Some(_) => {}
        None => windows.push(window),
    }
}

#[cfg(test)]
mod tests;
