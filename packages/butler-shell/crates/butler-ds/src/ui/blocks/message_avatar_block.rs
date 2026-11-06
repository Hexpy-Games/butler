//! DS MessageAvatarBlock (MessageAvatarBlock.tsx / MessageAvatarBlock.module.css): the 28px round
//! avatar of a message row. Its glyph fills the box; the role sets the ink (the product draws it
//! for system messages only).
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div, px};

use crate::tokens::Color;
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::icon_px;

/// The avatar's side. // DS: MessageAvatarBlock.module.css:3
const SIDE: f32 = 28.;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AvatarRole {
    #[default]
    Assistant,
    User,
    System,
}

#[derive(IntoElement)]
pub struct MessageAvatarBlock {
    role: AvatarRole,
    active: bool,
    glyph: Option<AnyElement>,
}

impl MessageAvatarBlock {
    pub fn new() -> Self {
        Self {
            role: AvatarRole::Assistant,
            active: false,
            glyph: None,
        }
    }

    pub fn role(mut self, role: AvatarRole) -> Self {
        self.role = role;
        self
    }

    /// The accent ink.
    pub fn active(mut self) -> Self {
        self.active = true;
        self
    }

    /// A glyph in place of the role's default (a `Bot`, or a `UserRound` for the user).
    pub fn glyph(mut self, glyph: impl IntoElement) -> Self {
        self.glyph = Some(glyph.into_any_element());
        self
    }
}

impl Default for MessageAvatarBlock {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for MessageAvatarBlock {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let ink = if self.active {
            Color::Accent
        } else {
            match self.role {
                AvatarRole::Assistant => Color::TextSecondary,
                AvatarRole::User => Color::TextPrimary,
                AvatarRole::System => Color::ColorWarning,
            }
        };
        let glyph = self.glyph.unwrap_or_else(|| {
            let icon = match self.role {
                AvatarRole::User => Icon::UserRound,
                _ => Icon::Bot,
            };
            icon_px(icon, px(SIDE)).into_any_element()
        });
        div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(SIDE))
            .rounded_full()
            .overflow_hidden()
            .text_color(ds.color(ink))
            .child(glyph)
    }
}
