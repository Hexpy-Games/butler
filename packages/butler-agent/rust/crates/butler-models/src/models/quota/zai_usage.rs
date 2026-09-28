//! The Z.AI Coding Plan `GET /api/monitor/usage/quota/limit` reply.
//!
//! Shape: `{code, msg, success, data: {level, limits: [...]}}`. Each limit
//! has `type` (`TOKENS_LIMIT` or `CREDIT_LIMIT` for model quota,
//! `TIME_LIMIT` for tool calls), `unit` + `number` (the window: unit 3 = hours,
//! unit 6 = weeks, unit 5 = months), `usage` (the limit), `currentValue`
//! (used), `remaining`, `percentage` (used, 0–100) and `nextResetTime`
//! (epoch milliseconds). Unknown windows are skipped, never guessed.

use serde::Deserialize;

use super::fetch::QuotaFetchError;
use super::lenient;
use super::{ProviderQuotaReading, ProviderQuotaSource, ProviderQuotaWindow};

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    success: Option<bool>,
    #[serde(default, deserialize_with = "lenient::number")]
    code: Option<f64>,
    #[serde(default)]
    data: Option<Data>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(default, deserialize_with = "lenient::text")]
    level: Option<String>,
    #[serde(default)]
    limits: Vec<Limit>,
}

#[derive(Deserialize)]
struct Limit {
    #[serde(default, rename = "type", deserialize_with = "lenient::text")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "lenient::number")]
    unit: Option<f64>,
    #[serde(default, deserialize_with = "lenient::number")]
    number: Option<f64>,
    #[serde(default, deserialize_with = "lenient::number")]
    usage: Option<f64>,
    #[serde(
        default,
        alias = "currentValue",
        alias = "current_value",
        deserialize_with = "lenient::number"
    )]
    current: Option<f64>,
    #[serde(default, deserialize_with = "lenient::number")]
    remaining: Option<f64>,
    #[serde(default, deserialize_with = "lenient::number")]
    percentage: Option<f64>,
    #[serde(
        default,
        alias = "nextResetTime",
        alias = "next_reset_time",
        deserialize_with = "lenient::number"
    )]
    next_reset: Option<f64>,
}

/// Z.AI's own codes for a rejected key (besides HTTP 401).
const AUTH_CODES: [u16; 5] = [401, 1000, 1001, 1002, 1003];

/// Parses a quota-limit body into a reading for `provider_id`.
pub(crate) fn parse_zai_quota(
    provider_id: &str,
    body: &[u8],
    now_ms: i64,
) -> Result<ProviderQuotaReading, QuotaFetchError> {
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| QuotaFetchError::Schema)?;
    let code = envelope
        .code
        .filter(|code| code.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(code))
        .map(butler_core::json::saturating_u16);
    // A rejected key is a rejection whatever `success` says.
    if let Some(status) = code.filter(|code| AUTH_CODES.contains(code)) {
        return Err(QuotaFetchError::Unauthorized { status });
    }
    if envelope.success == Some(false) {
        return Err(QuotaFetchError::Refused);
    }
    let data = envelope.data.ok_or(QuotaFetchError::Schema)?;
    let windows = windows(&data.limits);
    let plan_name = lenient::plan_name(data.level.as_deref());
    // A plan may report only its tool window (or only its level); that is a
    // reading, not a schema change.
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

/// Model-quota windows first (5-hour, weekly), then the monthly tool window.
/// A second limit of the same window gets a numbered id (`tokens-5-hour-2`).
fn windows(limits: &[Limit]) -> Vec<ProviderQuotaWindow> {
    let mut windows: Vec<ProviderQuotaWindow> = Vec::new();
    for limit in limits {
        let Some((base, minutes)) = window_kind(limit) else {
            continue;
        };
        let Some(used_percent) = used_percent(limit) else {
            continue;
        };
        let count = windows
            .iter()
            .filter(|window| window.id == base || window.id.starts_with(&format!("{base}-")))
            .count();
        let id = if count == 0 {
            base.to_owned()
        } else {
            format!("{base}-{}", count + 1)
        };
        windows.push(ProviderQuotaWindow {
            id,
            used_percent,
            window_minutes: minutes,
            resets_at_ms: limit.next_reset.and_then(lenient::epoch_millis),
        });
    }
    windows.sort_by_key(|window| window.id.starts_with("mcp-"));
    windows
}

/// The window id and length of a limit, `None` for an undocumented one.
fn window_kind(limit: &Limit) -> Option<(&'static str, Option<u64>)> {
    let unit = limit.unit?;
    let number = limit.number?;
    match limit.kind.as_deref()? {
        "TOKENS_LIMIT" | "CREDIT_LIMIT" if unit == 3.0 && number == 5.0 => {
            Some(("tokens-5-hour", Some(300)))
        }
        "TOKENS_LIMIT" | "CREDIT_LIMIT" if unit == 6.0 && number == 1.0 => {
            Some(("tokens-weekly", Some(10_080)))
        }
        "TIME_LIMIT" if unit == 5.0 => Some(("mcp-month", None)),
        _ => None,
    }
}

/// Used share, 0–100: `percentage`, else `currentValue` or `remaining`
/// against the `usage` limit.
fn used_percent(limit: &Limit) -> Option<f64> {
    let from_counts = || {
        let total = limit.usage.filter(|total| *total > 0.0)?;
        let used = limit
            .current
            .or_else(|| limit.remaining.map(|remaining| total - remaining))?;
        Some(used / total * 100.0)
    };
    limit
        .percentage
        .or_else(from_counts)
        .map(|value| value.clamp(0.0, 100.0))
}

#[cfg(test)]
mod tests;
