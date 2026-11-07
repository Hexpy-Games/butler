//! ChartTooltipContent (shadcn/ui/chart.tsx): the hovered category's title over one row per
//! series (swatch, name, value), on a popover surface that follows the pointer.
use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, Pixels, Point, Styled as _, div, px,
};

use super::scale::grouped;
use super::{Spec, TooltipTitle};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::context::Ds;
use crate::ui::convert;

/// How far the tooltip sits from the pointer (recharts' `offset`).
const OFFSET: f32 = 10.;
/// `min-width: 140px`.
const MIN_WIDTH: f32 = 140.; // DS: Chart.module.css:46

/// The tooltip for category `index`, placed beside the pointer `at` (chart-local) on the side
/// with room, inside a chart of `size`.
pub(super) fn content(
    spec: &Spec,
    index: usize,
    at: Point<Pixels>,
    size: gpui::Size<Pixels>,
    ds: &Ds,
) -> AnyElement {
    let title = match spec.title {
        TooltipTitle::Category => spec.categories.get(index).cloned(),
        TooltipTitle::FirstSeries => spec.series.first().map(|series| series.name.clone()),
    };
    let strong = |text: String| div().font_weight(FontWeight::BOLD).child(text);
    let rows = spec.series.iter().map(|series| {
        let value = series.values.get(index).copied().unwrap_or(0.);
        div()
            .flex()
            .items_center()
            .gap(ds.len(Length::Space2))
            .child(
                div()
                    .flex_none()
                    .size(px(8.))
                    .rounded(ds.len(Length::RadiusPill))
                    .bg(series.color),
            )
            .child(div().flex_1().child(series.name.to_string()))
            .child(strong(grouped(value)))
    });
    let card = div()
        .flex()
        .flex_col()
        .min_w(px(MIN_WIDTH))
        .p(ds.len(Length::Space2))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::Popover))
        .text_color(ds.color(Color::PopoverForeground))
        .text_size(ds.len(Length::TypoBodySize))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .shadow(convert::box_shadows(
            ds.tokens().shadow(Shadow::ShadowCard),
            ds.tokens(),
        ))
        .children(title.map(|title| strong(title.to_string())))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(ds.len(Length::Space1))
                .mt(ds.len(Length::Space2))
                .children(rows),
        );
    let mut wrapper = div().absolute();
    wrapper = if at.x > size.width / 2. {
        wrapper.right(size.width - at.x + px(OFFSET))
    } else {
        wrapper.left(at.x + px(OFFSET))
    };
    wrapper = if at.y > size.height / 2. {
        wrapper.bottom(size.height - at.y + px(OFFSET))
    } else {
        wrapper.top(at.y + px(OFFSET))
    };
    wrapper.child(card).into_any_element()
}
