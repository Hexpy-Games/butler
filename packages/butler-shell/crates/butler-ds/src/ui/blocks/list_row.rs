//! DS ListRow (ListRow.tsx / ListRow.module.css): a non-navigation row of an optional icon, a
//! title with its meta, and a description. The meta shares the title's line while it fits
//! beside a title that keeps half the line; a longer meta wraps below it.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window,
    div, relative,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::layout::{MinWidth, Space, Stack, WithItem as _};
use crate::ui::typo::{Tone, Typo, Weight};

#[derive(IntoElement)]
pub struct ListRow {
    icon: Option<AnyElement>,
    title: SharedString,
    description: Option<SharedString>,
    meta: Option<SharedString>,
}

impl ListRow {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            icon: None,
            title: title.into(),
            description: None,
            meta: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// A date, a size, a state.
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }
}

impl RenderOnce for ListRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let heading = div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap_x(ds.len(Length::SpaceMd))
            .gap_y(ds.len(Length::SpaceXs))
            .child(
                // `flex: 1 1 50%`: the title keeps half the line, so a long meta wraps below it.
                div()
                    .flex_grow(1.)
                    .flex_shrink(1.)
                    .flex_basis(relative(0.5))
                    .min_w_0()
                    .child(Typo::body(self.title).truncate().weight(Weight::Regular)),
            )
            .children(self.meta.map(|meta| {
                Typo::caption(meta)
                    .tone(Tone::Tertiary)
                    .wrap(crate::ui::typo::Wrap::Anywhere)
            }));
        let content = Stack::new()
            .gap(Space::Xs)
            .min_width(MinWidth::Zero)
            .child(heading)
            .children(
                self.description
                    .map(|text| Typo::caption(text).tone(Tone::Secondary)),
            );
        // The icon box is one title line tall, so it centres on the title's first line.
        let icon = self.icon.map(|icon| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .h(ds.len(Length::TypoBodyLineHeight))
                .text_color(ds.color(Color::TextTertiary))
                .child(icon)
        });
        div()
            .flex()
            .w_full()
            .items_start()
            .gap(ds.len(Length::Space2))
            .p(ds.len(Length::Space2))
            .children(icon)
            .child(div().flex_1().min_w_0().child(content))
    }
}
