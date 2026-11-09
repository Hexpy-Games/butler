//! DS DashboardHeader (DashboardHeader.tsx / DashboardHeader.module.css): a page's title row:
//! the title with an optional description and meta line, and an optional action on the right.
//! At 640px and below the action drops under the copy.
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _,
    Window, div,
};

use crate::ui::context::Ds;
use crate::ui::layout::{MinWidth, Space, Stack, WithItem as _};
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo};

#[derive(IntoElement)]
pub struct DashboardHeader {
    title: SharedString,
    description: Option<SharedString>,
    action: Option<AnyElement>,
    meta: Option<SharedString>,
}

impl DashboardHeader {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            action: None,
            meta: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }
}

impl RenderOnce for DashboardHeader {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let copy = Stack::new()
            .gap(Space::Sm)
            .min_width(MinWidth::Zero)
            .child(Typo::dashboard_title(self.title).tone(Tone::Primary))
            .children(
                self.description
                    .filter(|text| !text.is_empty())
                    .map(|text| Typo::body(text).tone(Tone::Secondary)),
            )
            .children(
                self.meta
                    .filter(|text| !text.is_empty())
                    .map(|text| Typo::caption(text).tone(Tone::Secondary)),
            );
        let header = div()
            .flex()
            .w_full()
            .items_start()
            .justify_between()
            .gap(Space::Lg.px(ds));
        let header = if ds.compact() {
            header.flex_col()
        } else {
            header.flex_row()
        };
        strut::flex_scope(
            false,
            header
                .child(copy)
                .children(self.action.map(|action| div().flex_none().child(action))),
        )
    }
}
