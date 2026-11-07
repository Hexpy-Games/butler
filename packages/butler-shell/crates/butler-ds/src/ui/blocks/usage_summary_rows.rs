//! DS UsageSummaryRows (UsageSummaryRows.tsx / usageFormat.ts): provider usage for a popover or
//! panel: quota windows as meters, token counts and a USD cost as label and value rows, plus the
//! loading, unavailable and stale states. Presenter only: the caller passes copy and numbers.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};

use crate::tokens::Length;
use crate::ui::animated_number::AnimatedNumber;
use crate::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use crate::ui::blocks::progress_meter::ProgressMeter;
use crate::ui::context::{Ds, Lang};
use crate::ui::skeleton::SkeletonRows;
use crate::ui::typo::{Tone, Typo};

const DASH: &str = "—";

/// `formatUsageUsd`: USD in every locale: two decimals from one cent, four below one cent,
/// "<$0.0001" for a smaller non-zero amount, "—" for a missing number.
pub fn format_usd(value: f64) -> String {
    if !value.is_finite() {
        return DASH.to_owned();
    }
    let amount = value.max(0.);
    if amount == 0. || amount >= 0.01 {
        let cents = format!("{amount:.2}");
        let (whole, fraction) = cents.split_once('.').unwrap_or((&cents, "00"));
        return format!(
            "${}.{fraction}",
            crate::ui::animated_number::grouped(whole.parse().unwrap_or(0.))
        );
    }
    if amount < 0.00005 {
        return "<$0.0001".to_owned();
    }
    format!("${amount:.4}")
}

/// A compact count with at most one fraction digit: 12.3 with its unit.
fn compact(value: f64, unit: f64, suffix: &str) -> String {
    let scaled = (value / unit * 10.).round() / 10.;
    if scaled.fract() == 0. {
        format!("{scaled:.0}{suffix}")
    } else {
        format!("{scaled:.1}{suffix}")
    }
}

/// `formatUsageTokens`: a compact token count; English "12.3k", Korean "1.2만"; below 1,000 the
/// plain number.
pub fn format_tokens(value: f64, lang: Lang) -> String {
    if !value.is_finite() {
        return DASH.to_owned();
    }
    let count = value.max(0.).round();
    let units: &[(f64, &str)] = match lang {
        Lang::En => &[(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")],
        Lang::Ko => &[(1e12, "조"), (1e8, "억"), (1e4, "만"), (1e3, "천")],
    };
    units.iter().find(|(unit, _)| count >= *unit).map_or_else(
        || format!("{count:.0}"),
        |(unit, suffix)| compact(count, *unit, suffix),
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UsageState {
    #[default]
    Ready,
    Loading,
    Unavailable,
}

/// A quota window: its name, the percent left (none when the provider reports none) and a line
/// under the meter.
pub struct QuotaWindow {
    pub id: SharedString,
    pub label: SharedString,
    pub remaining_percent: Option<f64>,
    pub caption: Option<SharedString>,
}

pub struct TokenRow {
    pub id: SharedString,
    pub label: SharedString,
    pub value: f64,
}

/// The cost row: USD (none when unpriced) and whether it is an estimate.
pub struct CostRow {
    pub label: SharedString,
    pub usd: Option<f64>,
    pub estimated: bool,
}

type Remaining = Rc<dyn Fn(&str) -> String>;

#[derive(IntoElement)]
pub struct UsageSummaryRows {
    id: ElementId,
    state: UsageState,
    windows: Vec<QuotaWindow>,
    tokens: Vec<TokenRow>,
    cost: Option<CostRow>,
    remaining_label: Remaining,
    estimate_label: Option<SharedString>,
    unavailable_label: SharedString,
    updated_label: Option<SharedString>,
}

impl UsageSummaryRows {
    pub fn new(id: impl Into<ElementId>, unavailable_label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            state: UsageState::Ready,
            windows: Vec::new(),
            tokens: Vec::new(),
            cost: None,
            remaining_label: Rc::new(str::to_owned),
            estimate_label: None,
            unavailable_label: unavailable_label.into(),
            updated_label: None,
        }
    }

    pub fn state(mut self, state: UsageState) -> Self {
        self.state = state;
        self
    }

    pub fn quota_windows(mut self, windows: Vec<QuotaWindow>) -> Self {
        self.windows = windows;
        self
    }

    pub fn tokens(mut self, tokens: Vec<TokenRow>) -> Self {
        self.tokens = tokens;
        self
    }

    pub fn cost(mut self, cost: CostRow) -> Self {
        self.cost = Some(cost);
        self
    }

    /// Meter meta from the rounded percent ("90%"), e.g. "90% left".
    pub fn remaining_label(mut self, label: impl Fn(&str) -> String + 'static) -> Self {
        self.remaining_label = Rc::new(label);
        self
    }

    /// The marker after an estimated cost ("est.").
    pub fn estimate_label(mut self, label: impl Into<SharedString>) -> Self {
        self.estimate_label = Some(label.into());
        self
    }

    /// Marks the data stale and shows this caption ("Updated 14:05").
    pub fn updated_label(mut self, label: impl Into<SharedString>) -> Self {
        self.updated_label = Some(label.into());
        self
    }
}

fn percent_text(value: f64) -> String {
    format!("{:.0}%", value.clamp(0., 100.).round())
}

impl UsageSummaryRows {
    fn quota(&self, window: &QuotaWindow, ds: &Ds) -> AnyElement {
        let meter = match window
            .remaining_percent
            .filter(|percent| percent.is_finite())
        {
            None => KeyValueRow::new(window.label.clone(), DASH)
                .value_size(ValueSize::Caption)
                .into_any_element(),
            Some(percent) => {
                let remaining = self.remaining_label.clone();
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "a finite percentage of a quota window; f32 holds it to display precision"
                )]
                let percent = percent as f32;
                ProgressMeter::new((self.id.clone(), window.id.clone()), percent)
                    .label(window.label.clone())
                    .meta_element(
                        AnimatedNumber::new(
                            (
                                self.id.clone(),
                                SharedString::from(format!("{}-meta", window.id)),
                            ),
                            percent,
                        )
                        .format(move |value| remaining(&percent_text(value))),
                    )
                    .into_any_element()
            }
        };
        div()
            .flex()
            .flex_col()
            .gap(ds.len(Length::SpaceXs))
            .child(meter)
            .children(
                window
                    .caption
                    .clone()
                    .map(|caption| Typo::caption(caption).tone(Tone::Tertiary)),
            )
            .into_any_element()
    }

    fn cost_value(&self, cost: &CostRow, ds: &Ds) -> AnyElement {
        let Some(usd) = cost.usd.filter(|usd| usd.is_finite()) else {
            return div().child(DASH).into_any_element();
        };
        let estimate = cost
            .estimated
            .then(|| self.estimate_label.clone())
            .flatten()
            .map(|label| {
                div()
                    .ml(ds.len(Length::SpaceXs))
                    .child(Typo::caption(label).tone(Tone::Tertiary))
            });
        div()
            .flex()
            .items_baseline()
            .child(AnimatedNumber::new((self.id.clone(), "cost"), usd).format(format_usd))
            .children(estimate)
            .into_any_element()
    }
}

impl RenderOnce for UsageSummaryRows {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        match self.state {
            UsageState::Loading => {
                return div()
                    .flex()
                    .flex_col()
                    .gap(ds.len(Length::SpaceSm))
                    .child(SkeletonRows::new((self.id, "loading")).rows(3))
                    .into_any_element();
            }
            UsageState::Unavailable => {
                return div()
                    .flex()
                    .flex_col()
                    .gap(ds.len(Length::SpaceSm))
                    .child(Typo::caption(self.unavailable_label).tone(Tone::Tertiary))
                    .into_any_element();
            }
            UsageState::Ready => {}
        }
        let lang = ds.lang();
        let windows = (!self.windows.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(ds.len(Length::SpaceMd))
                .children(self.windows.iter().map(|window| self.quota(window, ds)))
        });
        let rows = (!self.tokens.is_empty() || self.cost.is_some()).then(|| {
            let tokens = self.tokens.iter().map(|row| {
                KeyValueRow::new(row.label.clone(), "")
                    .value_element(
                        AnimatedNumber::new((self.id.clone(), row.id.clone()), row.value)
                            .format(move |value| format_tokens(value, lang)),
                    )
                    .value_size(ValueSize::Caption)
            });
            let cost = self.cost.as_ref().map(|cost| {
                KeyValueRow::new(cost.label.clone(), "")
                    .value_element(self.cost_value(cost, ds))
                    .value_size(ValueSize::Caption)
            });
            div().flex().flex_col().children(tokens).children(cost)
        });
        div()
            .flex()
            .flex_col()
            .gap(ds.len(Length::SpaceMd))
            .children(windows)
            .children(rows)
            .children(
                self.updated_label
                    .clone()
                    .map(|label| Typo::caption(label).tone(Tone::Tertiary)),
            )
            .into_any_element()
    }
}
