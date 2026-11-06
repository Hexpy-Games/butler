//! DS KeyValueRow (KeyValueRow.tsx / KeyValueRow.module.css / useKeyValueRowLink.ts): a compact
//! row of a label and its value on one baseline, an optional description and meta under them,
//! and an optional 10px swatch on the label line. A row linked to a chart (`on_highlight`)
//! is one focusable group that reports mouse hover and keyboard focus.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Hsla, InteractiveElement as _, IntoElement, ParentElement,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    pattern_slash, px,
};

use crate::tokens::{Color, Length, Percent};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::focus;
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::typo::{TextAlign, Tone, Typo, Weight, Wrap};

type Highlight = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// The swatch fill (`swatchPattern`): solid, or the UsageBars subtask hatch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SwatchPattern {
    #[default]
    Solid,
    Hatched,
}

/// Which text size the value takes (`valueTextSize`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ValueSize {
    #[default]
    Body,
    Caption,
}

/// How the description and meta line up (`detailAlign`, `detailLayout`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Detail {
    /// One line, the description at the start, the meta at the end, centred on each other.
    #[default]
    Row,
    /// One line, aligned to the first line of the description.
    RowStart,
    /// The meta under the description.
    Stack,
}

#[derive(IntoElement)]
pub struct KeyValueRow {
    label: SharedString,
    value: SharedString,
    description: Option<SharedString>,
    meta: Option<SharedString>,
    swatch: Option<AnyElement>,
    swatch_color: Option<Hsla>,
    pattern: SwatchPattern,
    value_size: ValueSize,
    detail: Detail,
    link: Option<(ElementId, Highlight)>,
}

impl KeyValueRow {
    pub fn new(label: impl Into<SharedString>, value: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
            description: None,
            meta: None,
            swatch: None,
            swatch_color: None,
            pattern: SwatchPattern::Solid,
            value_size: ValueSize::Body,
            detail: Detail::Row,
            link: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// Custom swatch content.
    pub fn swatch(mut self, swatch: impl IntoElement) -> Self {
        self.swatch = Some(swatch.into_any_element());
        self
    }

    pub fn swatch_color(mut self, color: Hsla) -> Self {
        self.swatch_color = Some(color);
        self
    }

    pub fn swatch_pattern(mut self, pattern: SwatchPattern) -> Self {
        self.pattern = pattern;
        self
    }

    pub fn value_size(mut self, size: ValueSize) -> Self {
        self.value_size = size;
        self
    }

    pub fn detail(mut self, detail: Detail) -> Self {
        self.detail = detail;
        self
    }

    /// Links the row to a chart: it becomes one tab stop and reports mouse hover and keyboard
    /// focus (true) and their end (false), so the chart can emphasise the series it names.
    pub fn on_highlight_change(
        mut self,
        id: impl Into<ElementId>,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.link = Some((id.into(), Rc::new(handler)));
        self
    }
}

/// The 10px round swatch on the label line: custom content, or the colour solid or hatched.
fn swatch(row: &mut KeyValueRow, ds: &Ds) -> Option<AnyElement> {
    let color = row.swatch_color;
    if row.swatch.is_none() && color.is_none() {
        return None;
    }
    let fill = match (row.swatch.take(), color) {
        (Some(custom), _) => custom,
        (None, Some(color)) if row.pattern == SwatchPattern::Hatched => {
            let base = convert::with_alpha(color, ds.tokens().percent(Percent::HatchAlpha));
            // `repeating-linear-gradient(135deg, c 0 2px, c@hatch-alpha 2px 4px)`
            let pill = ds.len(Length::RadiusPill);
            div()
                .size_full()
                .rounded(pill)
                .bg(base)
                .child(
                    div()
                        .size_full()
                        .rounded(pill)
                        .bg(pattern_slash(color, 2., 4.)),
                )
                .into_any_element()
        }
        (None, Some(color)) => div()
            .size_full()
            .rounded(ds.len(Length::RadiusPill))
            .bg(color)
            .into_any_element(),
        (None, None) => return None,
    };
    Some(
        div()
            .flex()
            .flex_none()
            .self_center()
            .items_center()
            .justify_center()
            .size(px(SWATCH))
            .child(fill)
            .into_any_element(),
    )
}

/// The swatch's side.
const SWATCH: f32 = 10.; // DS: KeyValueRow.module.css:20

impl KeyValueRow {
    fn main_row(&mut self, ds: &Ds) -> Stack {
        let swatch = swatch(self, ds);
        // The group takes its baseline from the label, not the swatch (`.labelGroup` centres the
        // swatch on the text, which the browser baseline-aligns by its first text).
        let label = div()
            .flex()
            .items_baseline()
            .min_w_0()
            .gap(ds.len(Length::Space2))
            .children(swatch)
            .child(
                Typo::caption(self.label.clone())
                    .tone(Tone::Tertiary)
                    .wrap(Wrap::Anywhere),
            );
        let value = match self.value_size {
            ValueSize::Body => Typo::body(self.value.clone()),
            ValueSize::Caption => Typo::caption(self.value.clone()),
        }
        .tone(Tone::Primary)
        .weight(Weight::Regular)
        .align(TextAlign::End)
        .wrap(Wrap::Anywhere);
        Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Baseline)
            .gap(Space::Sm)
            .min_width(MinWidth::Zero)
            .child(label)
            .child(div().min_w_0().child(value))
    }

    fn detail_row(&mut self, ds: &Ds, with_swatch: bool) -> Option<AnyElement> {
        if self.description.is_none() && self.meta.is_none() {
            return None;
        }
        let stacked = self.detail == Detail::Stack;
        let line = if stacked {
            Stack::new().gap(Space::Xs).cross(Cross::Start)
        } else {
            Stack::row()
                .justify(Justify::Between)
                .cross(if self.detail == Detail::RowStart {
                    Cross::Start
                } else {
                    Cross::Center
                })
                .gap(Space::Sm)
        };
        let line = line
            .min_width(MinWidth::Zero)
            .children(self.description.take().map(|text| {
                div().min_w_0().child(
                    Typo::caption(text)
                        .tone(Tone::Tertiary)
                        .wrap(Wrap::Anywhere),
                )
            }))
            .children(self.meta.take().map(|text| {
                div().flex_none().min_w_0().child(
                    Typo::caption(text)
                        .tone(Tone::Tertiary)
                        .align(if stacked {
                            TextAlign::Start
                        } else {
                            TextAlign::End
                        })
                        .wrap(Wrap::Anywhere),
                )
            }));
        let inset = if with_swatch {
            px(SWATCH) + ds.len(Length::Space2)
        } else {
            px(0.)
        };
        Some(div().pl(inset).child(line).into_any_element())
    }
}

impl RenderOnce for KeyValueRow {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let link = self.link.take();
        let ds = Ds::get(cx);
        let with_swatch = self.swatch.is_some() || self.swatch_color.is_some();
        let main = self.main_row(ds);
        let detail = self.detail_row(ds, with_swatch);
        let radius = ds.len(Length::RadiusControl);
        // The grid has two `auto` rows, so the row gap holds even when the second is empty.
        let detail = detail.unwrap_or_else(|| div().into_any_element());
        let row = div()
            .flex()
            .flex_col()
            .relative()
            .min_w_0()
            .min_h(px(28.)) // DS: KeyValueRow.module.css:9
            .py(px(2.)) // DS: KeyValueRow.module.css:10
            .gap(ds.len(Length::SpaceXs))
            .child(main)
            .child(detail);
        let Some((id, handler)) = link else {
            return row.into_any_element();
        };
        linked(row, id, (handler, radius), window, cx)
    }
}

/// The row as a focusable group: hover and keyboard focus report, and the shared ring shows on
/// keyboard focus, its outer edge within `--focus-ring-room` of the row.
fn linked(
    row: gpui::Div,
    id: ElementId,
    (handler, radius): (Highlight, gpui::Pixels),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let hover = window.use_keyed_state((id.clone(), "hover"), cx, |_, _| false);
    let seen = window.use_keyed_state((id.clone(), "seen-focus"), cx, |_, _| false);
    let handle = window
        .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    let focused = focus::visible(Ds::get(cx), handle.is_focused(window), false);
    let hovered = *hover.read(cx);
    if *seen.read(cx) != focused {
        seen.update(cx, |seen, _| *seen = focused);
        let handler = handler.clone();
        window.defer(cx, move |window, cx| {
            handler(focused || hovered, window, cx);
        });
    }
    let ds = Ds::get(cx);
    let ring = focused.then(|| {
        let width = ds.len(Length::FocusRingWidth);
        let reach = ds.len(Length::FocusRingRoom);
        div()
            .absolute()
            .top(-reach)
            .bottom(-reach)
            .left(-reach)
            .right(-reach)
            .rounded(radius + reach)
            .border(width)
            .border_color(ds.color(Color::ColorActionPrimary))
    });
    let focus_state = seen.clone();
    let anchor = id.to_string();
    row.id(id)
        .debug_selector(move || anchor.clone())
        .rounded(radius)
        .track_focus(&handle)
        .on_hover(move |on, window, cx| {
            hover.update(cx, |hover, _| *hover = *on);
            let keyboard = *focus_state.read(cx);
            handler(*on || keyboard, window, cx);
        })
        .children(ring)
        .into_any_element()
}
