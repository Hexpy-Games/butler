//! DS EmptyLine (EmptyLine.tsx / EmptyLine.module.css): a centred, dimmed icon above a message
//! and an optional action.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window, div,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Space, Stack};
use crate::ui::typo::{TextAlign, Tone, Typo};

#[derive(IntoElement)]
pub struct EmptyLine {
    icon: Option<AnyElement>,
    message: SharedString,
    action: Option<AnyElement>,
}

impl EmptyLine {
    pub fn new(message: impl Into<SharedString>) -> Self {
        Self {
            icon: None,
            message: message.into(),
            action: None,
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

impl RenderOnce for EmptyLine {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let icon = self.icon.map(|icon| {
            div()
                .flex()
                .opacity(0.6) // DS: EmptyLine.module.css:17
                .text_color(ds.color(Color::TextTertiary))
                .child(icon)
        });
        let rows = Stack::new()
            .gap(Space::Md)
            .cross(Cross::Center)
            .children(icon)
            .child(
                Typo::body(self.message)
                    .tone(Tone::Secondary)
                    .align(TextAlign::Center),
            )
            .children(self.action);
        div().w_full().p(ds.len(Length::Space2xl)).child(rows)
    }
}
