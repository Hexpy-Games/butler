//! MessageAvatarBlock.showcase.tsx: the system message avatar, and the three roles.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::message_avatar_block::{AvatarRole, MessageAvatarBlock};
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, IntoElement as _, ParentElement as _, px};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "System message avatar",
            render: |lang, _, _| system(lang),
        },
        Story {
            name: "Roles",
            render: |_, _, _| roles(),
        },
    ]
}

fn system(lang: Lang) -> AnyElement {
    let text = lang.pick(
        "System messages keep a Bot avatar; assistant turns show the Butler mark in the status line instead.",
        "시스템 메시지는 Bot 아바타를 쓰고, 어시스턴트 턴은 상태 줄에 버틀러 마크를 보여 줍니다.",
    );
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(
            MessageAvatarBlock::new()
                .role(AvatarRole::System)
                .glyph(icon_px(Icon::Bot, px(28.))),
        )
        .child(Typo::caption(text).tone(Tone::Secondary))
        .into_any_element()
}

fn roles() -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .child(
                    MessageAvatarBlock::new()
                        .active()
                        .glyph(icon_px(Icon::Sparkles, px(28.))),
                )
                .child(MessageAvatarBlock::new().role(AvatarRole::User))
                .child(MessageAvatarBlock::new().role(AvatarRole::System)),
        )
        .child(Typo::caption("assistant (active) · user · system").tone(Tone::Secondary))
        .into_any_element()
}
