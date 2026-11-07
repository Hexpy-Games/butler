//! The subscription section of the context popover: a ChatGPT plan's usage
//! (`chatgpt/ChatGptPlanUsage.tsx`) or the account limits, and `settings/ProviderQuotaGauge.tsx`.
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::blocks::progress_meter::{MeterTone, ProgressMeter};
use butler_ds::ui::blocks::usage_summary_rows::{UsageSummaryRows, format_tokens};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant as ButtonVariant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::typo::Tone;
use gpui::{AnyElement, IntoElement as _, ParentElement as _};

use super::popover::{caption, eid};
use super::usage::{
    ButlerUsage, ProviderQuota, QuotaWindowView, Summary, quota_timestamp, window_label,
};
use crate::ui::i18n::composer::usage::{UsageCopy, copy};

const MANAGE_USAGE_URL: &str = "https://chatgpt.com/settings/usage";

/// The subscription section: a ChatGPT plan's usage, or the account limits.
pub(super) fn account_section(summary: Summary, lang: Lang) -> AnyElement {
    let c = copy(lang);
    match summary {
        Summary::Plan { quota, butler } => plan_usage(&quota, butler.as_ref(), lang),
        Summary::Rows {
            state,
            windows,
            updated,
        } => {
            let mut rows = UsageSummaryRows::new(eid("account-rows"), c.unavailable)
                .state(state)
                .quota_windows(windows)
                .estimate_label(c.estimate)
                .remaining_label(move |percent| (copy(lang).left)(percent));
            if let Some(updated) = updated {
                rows = rows.updated_label(updated);
            }
            Stack::new()
                .gap(Space::Sm)
                .child(caption(c.account_limits))
                .child(rows)
                .into_any_element()
        }
    }
}

fn manage_button(id: &'static str, c: &UsageCopy) -> Button {
    Button::new(id)
        .size(ButtonSize::Sm)
        .variant(ButtonVariant::Inline)
        .text(c.manage_usage)
        .on_click(|_, _, cx| cx.open_url(MANAGE_USAGE_URL))
}

/// `ChatGptPlanUsage` with `popover`.
fn plan_usage(quota: &ProviderQuota, butler: Option<&ButlerUsage>, lang: Lang) -> AnyElement {
    let c = copy(lang);
    let limit = quota
        .plan_usage
        .as_ref()
        .is_some_and(|p| p.state == "limit_reached");
    let windows: &[QuotaWindowView] = if limit { &[] } else { &quota.windows };
    let mut body = Stack::new().gap(Space::Sm);
    if limit {
        let resets = quota
            .plan_usage
            .as_ref()
            .and_then(|p| p.resets_at.as_deref())
            .map(|at| format!(" · {}", (c.plan_resets_at)(&quota_timestamp(at, c))))
            .unwrap_or_default();
        body = body.child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .justify(Justify::Between)
                .child(
                    caption(format!("{}{resets}", c.limit_reached_plan))
                        .tone(Tone::Danger)
                        .grow()
                        .min_width(MinWidth::Zero),
                )
                .child(manage_button("plan-manage-limit", c)),
        );
    }
    if !windows.is_empty() {
        body = body.child(
            Stack::new()
                .gap(Space::Sm)
                .child(caption(c.account_limits))
                .children(windows.iter().map(|w| quota_gauge(w, lang))),
        );
        body = body.child(Separator::new());
    }
    let butler_rows = [
        ("hours_5", c.window_5h),
        ("days_7", c.window_7d),
        ("days_30", c.window_30d),
    ]
    .into_iter()
    .map(|(id, label)| {
        let total = butler
            .and_then(|b| b.windows.iter().find(|w| w.id == id))
            .map(|w| w.total_tokens);
        let text = total.map_or("—".to_owned(), |t| format_tokens(t, lang));
        KeyValueRow::new(label, format!("{text} {}", c.tokens)).value_size(ValueSize::Caption)
    });
    body.child(
        Stack::new()
            .gap(Space::Xs)
            .child(
                Stack::row()
                    .gap(Space::Sm)
                    .cross(Cross::Center)
                    .justify(Justify::Between)
                    .child(caption(c.butler_usage))
                    .children((!limit).then(|| manage_button("plan-manage", c))),
            )
            .children(butler_rows),
    )
    .into_any_element()
}

/// `ProviderQuotaGauge` (default layout, estimated): the label carries the estimate marker.
fn quota_gauge(window: &QuotaWindowView, lang: Lang) -> AnyElement {
    let c = copy(lang);
    let remaining = window
        .remaining_percent
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0., 100.));
    let text = window_label(window, c);
    let label = format!("{text} · {}", c.plan_estimate);
    let value = remaining.map_or_else(
        || c.unknown.to_owned(),
        |v| (c.remaining)(&format!("{}%", v.round())),
    );
    let meter: AnyElement = match remaining {
        None => Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Center)
            .justify(Justify::Between)
            .child(caption(label))
            .child(caption(value))
            .into_any_element(),
        Some(v) => {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "a percentage between 0 and 100"
            )]
            let fraction = v as f32;
            ProgressMeter::new((eid("gauge"), window.id.clone()), fraction)
                .label(label)
                .meta(value)
                .tone(if v == 0. {
                    MeterTone::Danger
                } else if v <= 20. {
                    MeterTone::Warning
                } else {
                    MeterTone::Default
                })
                .into_any_element()
        }
    };
    let details: Vec<String> = [
        window
            .resets_at
            .as_deref()
            .map(|at| (c.resets)(&quota_timestamp(at, c))),
        window
            .expires_at
            .as_deref()
            .map(|at| (c.expires)(&quota_timestamp(at, c))),
    ]
    .into_iter()
    .flatten()
    .collect();
    Stack::new()
        .gap(Space::Xs)
        .child(meter)
        .children((!details.is_empty()).then(|| caption(details.join(" · "))))
        .into_any_element()
}
