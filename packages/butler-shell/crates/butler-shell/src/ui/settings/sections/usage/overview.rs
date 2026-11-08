//! The "Recent usage" section of `UsageSettings.tsx`: the period and refresh actions, the chat
//! picker, the readout, the bars and the breakdown.
use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::blocks::usage_bars::{Size as BarsSize, State as BarsState, UsageBars};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::WithItem as _;
use butler_ds::ui::layout::{Basis, Cross, Inline, Justify, MaxWidth, MinWidth, Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size as SegmentSize};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Window};

use super::UsagePage;
use super::copy::{Words, words};
use super::format::clock_of;
use super::readout::{self, Part, Props};
use super::wire::{Monitor, TopSession};
use crate::ui::Icon;
use crate::ui::composer::context::timeline::{
    Timeline, TimelineBucket, usage_readout, usage_series, usage_share, usage_timeline,
    usage_tokens,
};
use crate::ui::i18n::composer::usage::copy;

/// `periodDelta`: how the range compares with the one before it.
fn period_delta(view: Option<&Monitor>, hours: u32, words: &Words) -> Option<String> {
    let view = view?;
    let total = view.model.totals.total_tokens;
    if total == 0. {
        return Some(words.empty_range.to_owned());
    }
    let label = (words.previous_period)(hours);
    let previous = view.previous_period.as_ref().map_or(0., |p| p.total_tokens);
    if previous == 0. {
        return Some((words.previous_empty)(label));
    }
    let delta = (total - previous) / previous * 100.;
    Some(if delta.abs() < 1. {
        words.similar.to_owned()
    } else {
        (words.delta)(label, &delta.abs().round().to_string(), delta > 0.)
    })
}

impl UsagePage {
    pub(super) fn overview(
        &self,
        sessions: &[TopSession],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let key = self.key();
        let view = self.view();
        let loading = self.pending.as_deref() == Some(key.as_str());
        let failed = self.error.as_deref() == Some(key.as_str());
        let state = if failed && view.is_none() {
            SettingsSectionState::Error
        } else {
            SettingsSectionState::Ready
        };
        let updated = view.map_or_else(
            || "—".to_owned(),
            |view| (copy(lang).updated)(&clock_of(&view.usage.generated_at)),
        );
        let top = Inline::new()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Md)
            .child(
                Stack::new()
                    .gap(Space::Xs)
                    .grow()
                    .basis(Basis::Md)
                    .min_width(MinWidth::Zero)
                    .max_width(MaxWidth::Field)
                    .child(self.session_select(sessions, window, cx)),
            )
            .child(Typo::caption(updated));
        let timeline = usage_timeline(view.map(|view| &view.chart), 31, lang);
        let selected = self.selected_bar();
        let bucket = selected.and_then(|index| timeline.buckets.get(index));
        let parts = readout::parts(view.map(|view| &view.usage), bucket, lang);
        let bars = self.bars(&timeline, selected, parts.is_some(), lang, cx);
        let body = Stack::new()
            .gap(Space::Lg)
            .child(top)
            .child(self.readout(bucket, parts, lang, cx))
            .child(bars)
            .child(self.breakdown(sessions, view.is_none(), cx));
        SettingsSection::new(
            "usage-overview",
            SettingsSectionKind::Status,
            words.overview_title,
        )
        .state(state)
        .error_message(words.usage_failed)
        .on_retry(cx.listener(|this, _, _, cx| this.refresh(cx)))
        .actions(self.actions(loading, cx))
        .child(body)
    }

    /// The period control and Refresh.
    fn actions(&self, loading: bool, cx: &mut Context<Self>) -> AnyElement {
        let words = words(Ds::get(cx).lang());
        let page = cx.entity().downgrade();
        let ranges = SegmentedControl::new("usage-period", words.period, self.hours.to_string())
            .size(SegmentSize::Sm)
            .options([
                Choice::new("24", words.day),
                Choice::new("168", words.week),
                Choice::new("720", words.month),
            ])
            .on_value_change(move |value, _, cx| {
                if let Ok(hours) = value.parse() {
                    let _ = page.update(cx, |this, cx| this.set_hours(hours, cx));
                }
            });
        let mut refresh = Button::new("usage-refresh")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::RefreshCcw, IconSize::Sm, Ds::get(cx)))
            .text(words.refresh)
            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)));
        if loading {
            refresh = refresh.disabled();
        }
        Inline::new()
            .child(ranges)
            .child(refresh)
            .into_any_element()
    }

    /// The scope a selected bar belongs to: it stops applying when the view changes.
    fn scope(&self) -> String {
        format!(
            "{}/{}/{}",
            self.hours,
            self.session.as_deref().unwrap_or("null"),
            self.view()
                .map_or("", |view| view.usage.generated_at.as_str())
        )
    }

    /// `selected`
    fn selected_bar(&self) -> Option<usize> {
        let scope = self.scope();
        self.selection
            .as_ref()
            .filter(|(selection, _)| *selection == scope)
            .map(|(_, index)| *index)
    }

    fn readout(
        &self,
        bucket: Option<&TimelineBucket>,
        parts: Option<Vec<Part>>,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let view = self.view();
        let page = cx.entity().downgrade();
        let share = self
            .session
            .as_ref()
            .zip(self.all_view())
            .filter(|(_, all)| all.usage.model.totals.total_tokens > 0.)
            .map(|(_, all)| {
                let session = view.map_or(0., |view| view.usage.model.totals.total_tokens);
                usage_share(session / all.usage.model.totals.total_tokens, lang)
            });
        readout::readout(
            Props {
                view: view.map(|view| &view.usage),
                values: usage_readout(view.map(|view| &view.chart), bucket),
                label: bucket.map(|bucket| bucket.label.as_str()),
                selected: bucket.is_some(),
                delta: period_delta(view.map(|view| &view.usage), self.hours, words(lang)),
                share,
                parts,
                on_emphasis: Rc::new(move |emphasis, _, cx| {
                    let _ = page.update(cx, |this, cx| {
                        this.emphasis = emphasis;
                        cx.notify();
                    });
                }),
                lang,
            },
            cx,
        )
    }

    fn bars(
        &self,
        timeline: &Timeline,
        selected: Option<usize>,
        has_parts: bool,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (page, scope) = (cx.entity().downgrade(), self.scope());
        UsageBars::new(
            "usage-bars",
            timeline.buckets.iter().map(|b| b.bar.clone()).collect(),
            usage_series(copy(lang)),
        )
        .size(BarsSize::Panel)
        .selected(selected)
        .axis_labels(timeline.axis_labels.clone())
        .emphasis(if has_parts { self.emphasis } else { None })
        .state(if self.view().is_none() {
            BarsState::Loading
        } else {
            BarsState::Ready
        })
        .empty_label(copy(lang).no_usage)
        .y_ticks(move |value| usage_tokens(value, lang))
        .on_select(move |index, _, cx| {
            let _ = page.update(cx, |this, cx| {
                this.selection = index.map(|index| (scope.clone(), index));
                cx.notify();
            });
        })
        .into_any_element()
    }
}
