//! `usageAuthMode.ts`, `conversationUsage.ts` and the loaders of `useConversationUsage.ts`: the
//! billing mode of the conversation's model, the `/usage-monitor` and `/provider-quota` views
//! (the fields the popover reads) and the subscription section built from them.
use butler_ds::ui::blocks::usage_bars::{civil_from_days, day_and_hour};
use butler_ds::ui::blocks::usage_summary_rows::{QuotaWindow, UsageState};
use butler_ds::ui::context::Lang;
use butler_shell_client::ShellClient;
use serde::Deserialize;

use crate::ui::i18n::composer::usage::{UsageCopy, copy};
use crate::ui::source::wire::ContextDetailsView;

/// How the conversation's model is billed, which picks the popover's usage section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageAuthMode {
    Subscription,
    ApiKey,
    Local,
    Unknown,
}

impl UsageAuthMode {
    /// Subscription and API-key models show this chat's usage.
    pub(super) fn tracked(self) -> bool {
        matches!(self, Self::Subscription | Self::ApiKey)
    }
}

/// The fields of an `AppModelSummary` the mode reads.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UsageModel {
    pub(crate) model_ref: String,
    pub(crate) provider_id: String,
    /// `platform`: set for local runtimes (llama_cpp, ollama, lm_studio, custom).
    pub(crate) platform: Option<String>,
    /// `auth_type`: "chatgpt_oauth" or "api_key".
    pub(crate) auth_type: Option<String>,
}

pub(crate) fn usage_auth_mode(
    model: Option<&UsageModel>,
    context: &ContextDetailsView,
) -> UsageAuthMode {
    let local_model = model.is_some_and(|m| m.provider_id == "local" || m.platform.is_some());
    if local_model || context.provider_id.as_deref() == Some("local") {
        return UsageAuthMode::Local;
    }
    match model.and_then(|m| m.auth_type.as_deref()) {
        Some("chatgpt_oauth") => UsageAuthMode::Subscription,
        Some("api_key") => UsageAuthMode::ApiKey,
        _ => UsageAuthMode::Unknown,
    }
}

/// The catalog model the context was measured with; the active model when the context names none.
pub(crate) fn context_model<'a>(
    models: &'a [UsageModel],
    context: &ContextDetailsView,
    active: Option<&'a UsageModel>,
) -> Option<&'a UsageModel> {
    match context.model_ref.as_deref() {
        None | Some("") => active,
        Some(model_ref) => models.iter().find(|m| m.model_ref == model_ref),
    }
}

/// `UsageMonitorView`, the parts the popover reads.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct UsageMonitorView {
    pub(super) timeline: UsageTimelineView,
    pub(super) filters: UsageFilters,
    pub(super) model: UsageModelTotals,
    pub(super) provider_usage: ProviderUsage,
    pub(super) cost: UsageCost,
    #[serde(rename = "generated_at")]
    pub(super) generated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct UsageTimelineView {
    /// `[start_ms, requests, prompt, cached, output, ...]` per 15-minute slot.
    pub(super) slots: Vec<Vec<f64>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct UsageFilters {
    pub(super) session_id: Option<String>,
    pub(super) since_ts: Option<f64>,
    pub(super) until_ts: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct UsageTotals {
    pub(super) request_count: f64,
    pub(super) prompt_tokens: f64,
    pub(super) cached_tokens: f64,
    pub(super) total_tokens: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct UsageModelTotals {
    #[serde(flatten)]
    pub(super) totals: UsageTotals,
    pub(super) subtasks: Option<UsageTotals>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct UsageCost {
    pub(super) available: bool,
    pub(super) estimated_usd: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ProviderUsage {
    pub(super) active_provider_id: Option<String>,
    pub(super) providers: Vec<ProviderEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ProviderEntry {
    pub(super) provider_id: String,
    pub(super) remaining: Option<ProviderQuota>,
    pub(super) butler_usage: Option<ButlerUsage>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ButlerUsage {
    pub(super) windows: Vec<ButlerUsageWindow>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ButlerUsageWindow {
    pub(super) id: String,
    pub(super) total_tokens: f64,
}

/// `ProviderQuotaResultView`, the parts the popover reads.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ProviderQuota {
    pub(super) available: bool,
    pub(super) stale: bool,
    pub(super) source_kind: String,
    pub(super) plan_usage: Option<PlanUsage>,
    pub(super) windows: Vec<QuotaWindowView>,
    pub(super) fetched_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct PlanUsage {
    pub(super) state: String,
    pub(super) resets_at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct QuotaWindowView {
    pub(super) id: String,
    pub(super) remaining_percent: Option<f64>,
    pub(super) window_duration_mins: Option<f64>,
    pub(super) resets_at: Option<String>,
    pub(super) expires_at: Option<String>,
}

/// `loadConversationUsage`: this session's `/usage-monitor` view; `None` when the call fails.
pub(crate) async fn load_usage(client: &ShellClient, session_id: &str) -> Option<UsageMonitorView> {
    let value = client
        .get_usage_monitor(Some(session_id), None)
        .await
        .ok()?;
    serde_json::from_value(value).ok()
}

/// `loadProviderQuota`: the stored quota of a provider; `None` when the call fails.
pub(crate) async fn load_quota(client: &ShellClient, provider_id: &str) -> Option<ProviderQuota> {
    let value = client.get_provider_quota(provider_id).await.ok()?;
    serde_json::from_value(value).ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageStatus {
    Idle,
    Loading,
    Ready,
    Failed,
}

/// The wall-clock offset of the local zone, in milliseconds. The DS buckets and `usage_time` read
/// local calendar time as wall-clock milliseconds.
pub(crate) fn local_offset_ms() -> i64 {
    i64::from(chrono::Local::now().offset().local_minus_utc()) * 1000
}

/// The current time in epoch milliseconds (`Date.now()`).
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

pub(crate) fn parse_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.timestamp_millis())
}

const SAME_DAY_MS: i64 = 20 * 60 * 60 * 1000;
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// "Oct 2" / "10월 2일".
pub(super) fn month_day(wall: i64, lang: Lang) -> String {
    let (_, month, day) = civil_from_days(day_and_hour(wall).0);
    match lang {
        Lang::En => format!(
            "{} {day}",
            MONTHS[usize::try_from(month - 1).unwrap_or(0) % 12]
        ),
        Lang::Ko => format!("{month}월 {day}일"),
    }
}

/// "14:05" from wall-clock milliseconds.
pub(crate) fn clock(wall: i64) -> String {
    let minutes = wall.rem_euclid(86_400_000) / 60_000;
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// "14:05" today; "Oct 2" / "10월 2일" for another day; "—" when the date is unreadable.
pub(crate) fn usage_time(value: &str, now: i64, lang: Lang) -> String {
    let Some(at) = parse_ms(value) else {
        return "—".to_owned();
    };
    let offset = local_offset_ms();
    let (wall, wall_now) = (at + offset, now + offset);
    let same_day = (at - now).abs() < SAME_DAY_MS
        && civil_from_days(day_and_hour(wall).0).2 == civil_from_days(day_and_hour(wall_now).0).2;
    if same_day {
        clock(wall)
    } else {
        month_day(wall, lang)
    }
}

/// `formatQuotaTimestamp`: "10/02 14:05".
pub(super) fn quota_timestamp(value: &str, c: &UsageCopy) -> String {
    let Some(at) = parse_ms(value) else {
        return c.unknown.to_owned();
    };
    let wall = at + local_offset_ms();
    let (_, month, day) = civil_from_days(day_and_hour(wall).0);
    format!("{month:02}/{day:02} {}", clock(wall))
}

/// `windowLabel` of providerQuotaPresentation.
pub(super) fn window_label(window: &QuotaWindowView, c: &UsageCopy) -> String {
    let id = window.id.as_str();
    if id == "mcp-month" {
        return c.mcp_monthly.to_owned();
    }
    if id == "tokens-5-hour" || id.starts_with("tokens-5-hour-") {
        return c.five_hour.to_owned();
    }
    if id == "tokens-weekly" || id.starts_with("tokens-weekly-") {
        return c.weekly.to_owned();
    }
    if let Some(minutes) = window.window_duration_mins {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a window length in whole minutes"
        )]
        let minutes = minutes as i64;
        return (c.minutes_limit)(minutes);
    }
    if id == "individualLimit" {
        c.individual.to_owned()
    } else {
        c.provided_limit.to_owned()
    }
}

fn view_quota<'a>(
    view: &'a UsageMonitorView,
    context: &ContextDetailsView,
) -> Option<&'a ProviderQuota> {
    let provider_id = context
        .provider_id
        .as_deref()
        .or(view.provider_usage.active_provider_id.as_deref());
    view.provider_usage
        .providers
        .iter()
        .find(|p| Some(p.provider_id.as_str()) == provider_id)?
        .remaining
        .as_ref()
}

fn quota_windows(quota: &ProviderQuota, now: i64, lang: Lang) -> Option<Vec<QuotaWindow>> {
    let c = copy(lang);
    if !quota.available || quota.windows.is_empty() {
        return None;
    }
    Some(
        quota
            .windows
            .iter()
            .map(|window| QuotaWindow {
                id: window.id.clone().into(),
                label: window_label(window, c).into(),
                remaining_percent: window.remaining_percent,
                caption: window
                    .resets_at
                    .as_deref()
                    .map(|at| (c.resets)(&usage_time(at, now, lang)).into()),
            })
            .collect(),
    )
}

/// The popover's subscription section.
pub(super) enum Summary {
    /// A ChatGPT plan: its quota and Butler's own usage.
    Plan {
        quota: ProviderQuota,
        butler: Option<ButlerUsage>,
    },
    Rows {
        state: UsageState,
        windows: Vec<QuotaWindow>,
        updated: Option<String>,
    },
}

/// What `useConversationUsage` returns.
pub(super) struct ConversationUsage<'a> {
    pub(super) view: Option<&'a UsageMonitorView>,
    pub(super) quota: Option<&'a ProviderQuota>,
    pub(super) status: UsageStatus,
}

/// The popover's usage section for this conversation, or `None` when the mode has no account
/// quota (only subscriptions show this section).
pub(super) fn conversation_usage_summary(
    mode: UsageAuthMode,
    context: &ContextDetailsView,
    usage: &ConversationUsage,
    now: i64,
    lang: Lang,
) -> Option<Summary> {
    if mode != UsageAuthMode::Subscription {
        return None;
    }
    let c = copy(lang);
    let view = usage.view;
    // The monitor's quota is the one the whole page shows; the stored quota stands in until the
    // monitor answers.
    let own = view.and_then(|v| view_quota(v, context));
    let source = if own.is_some_and(|q| q.available) {
        own
    } else {
        usage.quota.or(own)
    };
    if let Some(source) =
        source.filter(|q| q.source_kind == "chatgpt_plan" && q.plan_usage.is_some())
    {
        let butler = view.and_then(|v| {
            v.provider_usage
                .providers
                .iter()
                .find(|p| p.provider_id == "openai")?
                .butler_usage
                .clone()
        });
        return Some(Summary::Plan {
            quota: source.clone(),
            butler,
        });
    }
    let Some(windows) = source.and_then(|q| quota_windows(q, now, lang)) else {
        let loading = view.is_none() && usage.status != UsageStatus::Failed;
        return Some(Summary::Rows {
            state: if loading {
                UsageState::Loading
            } else {
                UsageState::Unavailable
            },
            windows: Vec::new(),
            updated: None,
        });
    };
    let generated = view.map(|v| v.generated_at.as_str());
    let quota_updated = source
        .filter(|q| q.stale)
        .map(|q| q.fetched_at.as_deref().or(generated).unwrap_or(""));
    let stale_at = (usage.status == UsageStatus::Failed)
        .then_some(generated)
        .flatten();
    let updated = quota_updated
        .or(stale_at)
        .map(|at| (c.updated)(&usage_time(at, now, lang)));
    Some(Summary::Rows {
        state: UsageState::Ready,
        windows,
        updated,
    })
}
