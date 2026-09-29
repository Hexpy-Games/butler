//! Quota views: a stored reading as the App shows it, or why there is none.

use chrono::{DateTime, SecondsFormat, Utc};

use butler_models::models::{
    ProviderQuotaReading, ProviderQuotaSource, ProviderQuotaWindow, QuotaBilling, QuotaSupport,
    provider_quota_support,
};

use super::{
    ProviderQuotaView, QuotaPlanKind, QuotaPollStatus, QuotaUnavailableReason, QuotaWindowView,
};

/// A reading older than this is shown as stale.
const STALE_AFTER_MS: i64 = 15 * 60 * 1000;

/// Supported, but no reading yet.
pub(super) const PENDING: &str = "provider_quota_pending";
/// The provider offers no quota to read.
pub(super) const NOT_OFFERED: &str = "provider_quota_not_offered";
/// The latest poll failed.
pub(super) const FETCH_FAILED: &str = "provider_quota_fetch_failed";

/// The view of a stored reading. A poll that failed after the reading makes
/// it stale with reason `provider_quota_fetch_failed`.
pub(super) fn reading_view(
    reading: &ProviderQuotaReading,
    status: Option<QuotaPollStatus>,
    now_ms: i64,
) -> ProviderQuotaView {
    let reset_passed = reading
        .windows
        .iter()
        .any(|window| window.resets_at_ms.is_some_and(|reset| reset <= now_ms));
    let failed_since =
        matches!(status, Some(QuotaPollStatus::Failed(at)) if at >= reading.observed_at_ms);
    let (source_kind, source_id) = source(&reading.provider_id, reading.source);
    ProviderQuotaView {
        available: true,
        stale: failed_since || reset_passed || now_ms - reading.observed_at_ms > STALE_AFTER_MS,
        source_kind,
        source_id,
        plan_kind: QuotaPlanKind::Subscription,
        plan_name: reading.plan_name.clone(),
        windows: reading.windows.iter().map(window_view).collect(),
        fetched_at: iso(reading.observed_at_ms),
        reason: failed_since.then(|| reason(FETCH_FAILED)),
    }
}

/// The view of a provider without a reading, from its latest poll outcome
/// or, before any poll, its static quota support.
pub(super) fn without_reading(
    provider_id: &str,
    status: Option<QuotaPollStatus>,
) -> ProviderQuotaView {
    let support = provider_quota_support(provider_id);
    let (code, plan_kind) = match (status, support) {
        (Some(QuotaPollStatus::NotOffered(kind)), _) => (NOT_OFFERED, kind),
        (Some(QuotaPollStatus::Disabled), _) => (NOT_OFFERED, QuotaPlanKind::Unknown),
        (Some(QuotaPollStatus::Failed(_)), _) => (FETCH_FAILED, QuotaPlanKind::Subscription),
        (_, QuotaSupport::NotOffered(billing)) => (NOT_OFFERED, plan_kind(billing)),
        (_, QuotaSupport::Polled) => (PENDING, QuotaPlanKind::Unknown),
    };
    let source = match support {
        QuotaSupport::Polled => ProviderQuotaSource::UsageEndpoint,
        QuotaSupport::NotOffered(_) => ProviderQuotaSource::ResponseHeaders,
    };
    let (source_kind, source_id) = self::source(provider_id, source);
    ProviderQuotaView {
        available: false,
        stale: false,
        source_kind,
        source_id,
        plan_kind,
        plan_name: None,
        windows: Vec::new(),
        fetched_at: None,
        reason: Some(reason(code)),
    }
}

/// The view for a provider with no reading and no poll yet.
pub fn unavailable_view(provider_id: &str) -> ProviderQuotaView {
    without_reading(provider_id, None)
}

/// The plan kind of a provider that offers no quota.
pub(super) fn plan_kind(billing: QuotaBilling) -> QuotaPlanKind {
    match billing {
        QuotaBilling::Api => QuotaPlanKind::Api,
        QuotaBilling::Subscription => QuotaPlanKind::Subscription,
        QuotaBilling::Unknown => QuotaPlanKind::Unknown,
    }
}

fn source(provider_id: &str, source: ProviderQuotaSource) -> (String, String) {
    match (source, provider_id) {
        (ProviderQuotaSource::UsageEndpoint, "zai") => (
            "zai_usage_query".into(),
            "zai-coding-plan-usage-query".into(),
        ),
        (ProviderQuotaSource::UsageEndpoint, _) => (
            "provider_quota".into(),
            format!("{provider_id}-usage-endpoint"),
        ),
        (ProviderQuotaSource::ResponseHeaders, _) => (
            "provider_quota".into(),
            format!("{provider_id}-response-headers"),
        ),
    }
}

fn reason(code: &str) -> QuotaUnavailableReason {
    let message = match code {
        PENDING => "No quota has been read for this provider yet.",
        NOT_OFFERED => "The provider offers no remaining quota to read.",
        _ => "The provider's quota could not be checked.",
    };
    QuotaUnavailableReason {
        code: code.into(),
        message: message.into(),
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

fn iso(epoch_ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(epoch_ms)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
}
