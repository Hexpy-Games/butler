//! DS MetricCard and MetricGrid (MetricCard.tsx / MetricGrid.tsx and their CSS): a value, its
//! label, an optional trend icon and change. Numbers count to new values through AnimatedNumber.
//! A grid lays cards in 150px-and-up columns, or joins them into one card split by hairlines.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::animated_number::AnimatedNumber;
use crate::ui::context::Ds;
use crate::ui::layout::{Columns, Grid, Space};
use crate::ui::typo::{Role, Tone, Typo, Weight};

type Format = Rc<dyn Fn(f64) -> String>;

/// The direction a metric moved; it tints the icon and the change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trend {
    Up,
    Down,
    Neutral,
}

impl Trend {
    fn color(self, ds: &Ds) -> gpui::Hsla {
        ds.color(match self {
            Self::Up => Color::ColorSuccess,
            Self::Down => Color::ColorDanger,
            Self::Neutral => Color::TextTertiary,
        })
    }
}

enum Value {
    Text(SharedString),
    Number(f64, Option<Format>),
}

#[derive(IntoElement)]
pub struct MetricCard {
    id: ElementId,
    value: Value,
    label: SharedString,
    trend: Option<Trend>,
    change: Option<SharedString>,
    icon: Option<AnyElement>,
    tile: bool,
}

impl MetricCard {
    /// A text value (shown as is).
    pub fn text(
        id: impl Into<ElementId>,
        value: impl Into<SharedString>,
        label: impl Into<SharedString>,
    ) -> Self {
        Self::with(id, Value::Text(value.into()), label.into())
    }

    /// A numeric value: it counts to a new value.
    pub fn number(id: impl Into<ElementId>, value: f64, label: impl Into<SharedString>) -> Self {
        Self::with(id, Value::Number(value, None), label.into())
    }

    fn with(id: impl Into<ElementId>, value: Value, label: SharedString) -> Self {
        Self {
            id: id.into(),
            value,
            label,
            trend: None,
            change: None,
            icon: None,
            tile: false,
        }
    }

    /// Formats a numeric value (for example compact notation).
    pub fn format(mut self, format: impl Fn(f64) -> String + 'static) -> Self {
        if let Value::Number(_, slot) = &mut self.value {
            *slot = Some(Rc::new(format));
        }
        self
    }

    pub fn trend(mut self, trend: Trend) -> Self {
        self.trend = Some(trend);
        self
    }

    pub fn change(mut self, change: impl Into<SharedString>) -> Self {
        self.change = Some(change.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A tile of a joined grid: no border, corner or fill of its own, label and change on one line.
    fn tile(mut self) -> Self {
        self.tile = true;
        self
    }
}

impl RenderOnce for MetricCard {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let tint = self.trend.map(|trend| trend.color(ds));
        let value = match self.value {
            Value::Text(text) => Typo::metric_value(text).tabular().into_any_element(),
            Value::Number(number, format) => {
                let mut counter =
                    AnimatedNumber::new((self.id, "value"), number).role(Role::MetricValue);
                if let Some(format) = format {
                    counter = counter.format(move |value| format(value));
                }
                counter.into_any_element()
            }
        };
        let mut head = div()
            .flex()
            .items_center()
            .justify_between()
            .child(div().min_w_0().child(value));
        if let Some(icon) = self.icon {
            let mut slot = div().opacity(0.7).child(icon);
            if let Some(tint) = tint {
                slot = slot.text_color(tint);
            }
            head = head.child(slot);
        }
        let line = |text: Typo| if self.tile { text.truncate() } else { text };
        let mut card = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(ds.len(Length::SpaceXs))
            .text_color(ds.color(Color::TextPrimary))
            .child(head)
            .child(line(Typo::caption(self.label).tone(Tone::Secondary)));
        if let Some(change) = self.change {
            let mut text = div().min_w_0().child(line(
                Typo::caption(change)
                    .weight(Weight::Medium)
                    .tone(Tone::Inherit),
            ));
            if let Some(tint) = tint {
                text = text.text_color(tint);
            }
            card = card.child(text);
        }
        if self.tile {
            return card
                .flex_1()
                .p(ds.len(Length::SpaceMd))
                .bg(ds.color(Color::SurfaceRaised));
        }
        card.p(ds.len(Length::SpaceMd))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusControl))
            .bg(ds.color(Color::SurfaceRaised))
    }
}

/// Separate cards in a grid, or one card split by hairlines.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GridVariant {
    #[default]
    Cards,
    Joined,
}

/// The default column: 150px and up (`minmax(min(150px, 100%), 1fr)`).
const CARD_TRACK_MIN: u16 = 150; // DS: MetricGrid.module.css:2
/// A joined tile grows from this basis (`flex: 1 1 136px`).
const TILE_BASIS: f32 = 136.; // DS: MetricGrid.module.css:18

#[derive(IntoElement)]
pub struct MetricGrid {
    id: ElementId,
    columns: Option<Columns>,
    variant: GridVariant,
    cards: Vec<MetricCard>,
}

impl MetricGrid {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            columns: None,
            variant: GridVariant::Cards,
            cards: Vec::new(),
        }
    }

    /// A column preset; ignored by the joined variant.
    pub fn columns(mut self, columns: Columns) -> Self {
        self.columns = Some(columns);
        self
    }

    pub fn variant(mut self, variant: GridVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn child(mut self, card: MetricCard) -> Self {
        self.cards.push(card);
        self
    }
}

impl RenderOnce for MetricGrid {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.variant == GridVariant::Cards {
            let columns = self
                .columns
                .unwrap_or(Columns::auto_fill_min(CARD_TRACK_MIN));
            return Grid::new(self.id)
                .gap(Space::Md)
                .columns(columns)
                .children(self.cards)
                .into_any_element();
        }
        let ds = Ds::get(cx);
        let gap = px(1.); // DS: MetricGrid.module.css:13
        div()
            .flex()
            .flex_wrap()
            .gap(gap)
            .overflow_hidden()
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusControl))
            .bg(ds.color(Color::Line))
            .children(self.cards.into_iter().map(|card| {
                div()
                    .flex()
                    .flex_grow(1.)
                    .flex_shrink(1.)
                    .flex_basis(px(TILE_BASIS))
                    .min_w_0()
                    .child(card.tile())
            }))
            .into_any_element()
    }
}
