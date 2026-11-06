//! DS PanelHeader (PanelHeader.tsx / PanelHeader.module.css): a panel's title, an optional
//! description under it and the actions at the end.
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _,
    Window, div,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use crate::ui::typo::{Tone, Typo};

#[derive(IntoElement)]
pub struct PanelHeader {
    title: SharedString,
    description: Option<SharedString>,
    actions: Option<AnyElement>,
}

impl PanelHeader {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            actions: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }
}

impl RenderOnce for PanelHeader {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let text = Stack::new()
            .gap(Space::Xs)
            .min_width(MinWidth::Zero)
            .grow()
            .child(Typo::panel_title(self.title).tone(Tone::Primary))
            .children(
                self.description
                    .map(|text| Typo::caption(text).tone(Tone::Secondary)),
            );
        let actions = self.actions.map(|actions| {
            div()
                .flex()
                .items_center()
                .gap(ds.len(Length::SpaceXs))
                .child(actions)
        });
        div().w_full().py(ds.len(Length::SpaceMd)).child(
            Stack::row()
                .justify(Justify::Between)
                .cross(Cross::Center)
                .child(text)
                .children(actions),
        )
    }
}
