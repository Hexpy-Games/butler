//! Numeric-only header estimates and explicit plan-limit observations.
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};

/// Estimated credits; never used for routing or admission.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditsReading {
    pub has_credits: Option<bool>,
    pub unlimited: Option<bool>,
    pub balance: Option<String>,
}
/// A provider-confirmed limit, with an explicit reset only when supplied.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct PlanLimitReading {
    pub observed_at_ms: i64,
    pub resets_at_ms: Option<i64>,
}
pub(super) fn parse(headers: &HeaderMap) -> Option<CreditsReading> {
    let value = |key| headers.get(key)?.to_str().ok();
    let has_credits = value("x-codex-credits-has-credits").and_then(|s| s.parse().ok());
    let unlimited = value("x-codex-credits-unlimited").and_then(|s| s.parse().ok());
    let balance = value("x-codex-credits-balance")
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 32
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'-'))
        })
        .map(str::to_owned);
    (has_credits.is_some() || unlimited.is_some() || balance.is_some()).then_some(CreditsReading {
        has_credits,
        unlimited,
        balance,
    })
}
