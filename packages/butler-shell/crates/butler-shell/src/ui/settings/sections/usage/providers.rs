//! The "Remaining limits" section: `UsageProviderPanel.tsx`, `UsageProviderRow.tsx`, the usage
//! layout of `ProviderQuotaGauge.tsx` and `providerQuotaPresentation.ts`.
//!
//! CARVE-OUT(G-meter-tone): React tones a gauge's label and meta text disabled when the quota is
//! stale, and dims the whole gauge; the DS ProgressMeter takes plain text, so only the caption
//! under the gauge is toned.
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::blocks::progress_meter::{MeterTone, ProgressMeter};
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Border, Box as DsBox, Radius, Space, Stack};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, ElementId, IntoElement as _, ParentElement as _};
use serde::Deserialize;
use serde_json::Value;

use super::UsagePage;
use super::copy::{Words, words};
use super::format::{date_time, duration_minutes, meter_value, provider_name};
use super::wire::{ProviderEntry, Quota, QuotaWindow};
use crate::ui::composer::context::timeline::usage_tokens;
use crate::ui::composer::context::usage::{now_ms, parse_ms};
use crate::ui::composer::decode_catalog;
use crate::ui::i18n::composer::usage::{UsageCopy, copy};
use crate::ui::settings::controls::provider_mark;

/// The `providers` of `/model-catalog` that name a provider.
#[derive(Default, Deserialize)]
#[serde(default)]
struct CatalogProviders {
    providers: Vec<ProviderLabel>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ProviderLabel {
    provider_id: String,
    provider_label: String,
}

/// `windowLabel`
fn window_label(window: &QuotaWindow, c: &UsageCopy) -> String {
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
        return (c.minutes_limit)(minutes as i64);
    }
    if id == "individualLimit" {
        c.individual.to_owned()
    } else {
        c.provided_limit.to_owned()
    }
}

/// `planLabel`
fn plan_label(quota: &Quota, words: &Words) -> String {
    if let Some(name) = quota.plan_name.as_ref().filter(|name| !name.is_empty()) {
        return name.clone();
    }
    match quota.plan_kind.as_str() {
        "subscription" => words.subscription,
        "api" => words.api_usage,
        _ => words.unconfirmed,
    }
    .to_owned()
}

/// `formatRemaining`
fn format_remaining(value: Option<f64>, c: &UsageCopy) -> String {
    value.map_or_else(
        || c.unknown.to_owned(),
        |value| format!("{}%", value.clamp(0., 100.).round()),
    )
}

/// `PageQuotaGauge`: a window's remaining share and when it resets.
fn gauge(id: (ElementId, String), window: &QuotaWindow, stale: bool, lang: Lang) -> AnyElement {
    let (words, c) = (words(lang), copy(lang));
    let remaining = window
        .remaining_percent
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0., 100.));
    let label = window_label(window, c);
    let reset_id = (ElementId::from("usage-quota-reset"), id.1.clone());
    let reset = window.resets_at.as_ref().or(window.expires_at.as_ref());
    let reset_ms = reset.and_then(|reset| parse_ms(reset));
    #[expect(clippy::cast_precision_loss, reason = "minutes until a reset")]
    let relative = reset_ms
        .map(|at| duration_minutes(((at - now_ms()) as f64 / 60_000.).ceil().max(0.), words));
    let caption = if remaining == Some(0.) {
        Some(relative.as_deref().map_or_else(
            || words.limit_reached.to_owned(),
            |relative| (words.limit_resets_in)(relative),
        ))
    } else {
        relative.as_deref().map(words.resets_in)
    };
    let meter = match remaining {
        None => KeyValueRow::new(label, format_remaining(None, c))
            .value_size(ValueSize::Caption)
            .into_any_element(),
        Some(value) => ProgressMeter::new(id, meter_value(value))
            .label(label)
            .meta(format_remaining(Some(value), c))
            .tone(match value {
                0. => MeterTone::Danger,
                v if v <= 20. => MeterTone::Warning,
                _ => MeterTone::Default,
            })
            .into_any_element(),
    };
    let mut column = Stack::new().gap(Space::Xs).child(meter);
    if let Some(caption) = caption {
        let tone = if stale {
            Tone::Disabled
        } else if remaining == Some(0.) {
            Tone::Danger
        } else {
            Tone::Secondary
        };
        let text = Typo::caption(caption).tone(tone);
        column = column.child(match reset_ms {
            Some(at) => Tooltip::new(reset_id)
                .label(date_time(at, lang))
                .child(text)
                .into_any_element(),
            None => text.into_any_element(),
        });
    }
    column.into_any_element()
}

/// The provider's mark and name, its plan and whether the figures are estimated.
fn provider_head(
    provider: &ProviderEntry,
    name: String,
    quota: &Quota,
    pay_as_you_go: bool,
    lang: Lang,
) -> Stack {
    let words = words(lang);
    let key = |name: &'static str| (ElementId::from(name), provider.provider_id.clone());
    let plan = if pay_as_you_go {
        words.pay_as_you_go.to_owned()
    } else {
        plan_label(quota, words)
    };
    let mut head = Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .child(provider_mark(&provider.provider_id, None, true))
        .child(Typo::body(name))
        .child(Tag::new(key("usage-provider-plan"), plan));
    if quota.source_kind == "chatgpt_plan" {
        head = head.child(
            Tooltip::new(key("usage-provider-estimate"))
                .label(words.estimate_hint)
                .child(Tag::new(key("usage-provider-estimated"), words.estimated)),
        );
    }
    head
}

impl UsagePage {
    /// `useLastQuota`: windows and fetch time fall back to the last good quota.
    fn quota_of(&self, provider: &ProviderEntry) -> Quota {
        let mut quota = provider.remaining.clone();
        let last = self.last_quota.get(&provider.provider_id);
        if quota.windows.is_empty() {
            quota.windows = last.map(|last| last.windows.clone()).unwrap_or_default();
        }
        if quota.fetched_at.is_none() {
            quota.fetched_at = last.and_then(|last| last.fetched_at.clone());
        }
        quota
    }

    /// `UsageProviderRow`
    fn provider_row(&self, provider: &ProviderEntry, name: String, lang: Lang) -> AnyElement {
        let words = words(lang);
        let quota = self.quota_of(provider);
        let pay_as_you_go = quota.plan_kind == "api"
            && quota
                .reason
                .as_ref()
                .is_some_and(|reason| reason.code == "provider_quota_not_offered");
        let failed = quota.stale || (!quota.available && !pay_as_you_go);
        let checked = quota.fetched_at.as_deref().and_then(parse_ms).map(|at| {
            let age = (words.elapsed_minutes)(((now_ms() - at) / 60_000).max(0));
            if failed {
                (words.refresh_failed_stale)(&age)
            } else {
                (words.checked_ago)(&age)
            }
        });
        let limit_reached = quota
            .plan_usage
            .as_ref()
            .filter(|usage| usage.state == "limit_reached");
        let windows = match limit_reached {
            Some(usage) if quota.windows.is_empty() => vec![QuotaWindow {
                id: "individualLimit".to_owned(),
                remaining_percent: Some(0.),
                resets_at: usage.resets_at.clone(),
                ..QuotaWindow::default()
            }],
            _ => quota.windows.clone(),
        };
        let head = provider_head(provider, name, &quota, pay_as_you_go, lang);
        let body = if pay_as_you_go {
            KeyValueRow::new(
                words.this_month,
                usage_tokens(provider.month_tokens.unwrap_or_default(), lang),
            )
            .value_size(ValueSize::Caption)
            .into_any_element()
        } else {
            Stack::new()
                .gap(Space::Md)
                .children(windows.iter().map(|window| {
                    let id = (
                        ElementId::from("usage-quota"),
                        format!("{}/{}", provider.provider_id, window.id),
                    );
                    gauge(id, window, failed, lang)
                }))
                .into_any_element()
        };
        DsBox::new()
            .border(Border::Hairline)
            .radius(Radius::Control)
            .padding(Space::Md)
            .child(
                Stack::new()
                    .gap(Space::Md)
                    .child(
                        Stack::new()
                            .gap(Space::Xs)
                            .child(head)
                            .children(checked.map(Typo::caption)),
                    )
                    .child(body),
            )
            .into_any_element()
    }

    /// `UsageProviderPanel`: the providers in the order of the registered models.
    pub(super) fn providers_section(
        &self,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> Option<SettingsSection> {
        let mut providers = self
            .all_view()
            .or_else(|| self.view())?
            .usage
            .provider_usage
            .providers
            .clone();
        if providers.is_empty() {
            return None;
        }
        let state = self.ctx.state.read(cx);
        let catalog = state.catalog();
        let models = catalog.and_then(decode_catalog);
        let mut order: Vec<String> = Vec::new();
        for model in models
            .as_ref()
            .and_then(|c| c.registered_models.as_ref())
            .into_iter()
            .flatten()
        {
            if !order.iter().any(|id| id.as_str() == &*model.provider_id) {
                order.push(model.provider_id.to_string());
            }
        }
        let rank = |id: &str| {
            order
                .iter()
                .position(|item| item == id)
                .unwrap_or(order.len())
        };
        providers.sort_by_key(|provider| rank(&provider.provider_id));
        let labels: CatalogProviders = catalog
            .and_then(|catalog: &Value| CatalogProviders::deserialize(catalog).ok())
            .unwrap_or_default();
        let name = |id: &str| {
            let named = labels
                .providers
                .iter()
                .find(|item| item.provider_id == id)
                .map(|item| item.provider_label.clone())
                .or_else(|| {
                    models
                        .as_ref()?
                        .models
                        .iter()
                        .find(|item| &*item.provider_id == id)
                        .map(|item| item.provider_label.to_string())
                });
            named
                .filter(|label| !label.is_empty())
                .unwrap_or_else(|| provider_name(id))
        };
        let rows: Vec<AnyElement> = providers
            .iter()
            .map(|provider| self.provider_row(provider, name(&provider.provider_id), lang))
            .collect();
        let words = words(lang);
        Some(
            SettingsSection::new(
                "usage-providers",
                SettingsSectionKind::Status,
                words.remaining,
            )
            .state(if self.view().is_none() {
                SettingsSectionState::Loading
            } else {
                SettingsSectionState::Ready
            })
            .child(Stack::new().gap(Space::Lg).children(rows)),
        )
    }
}
