//! `ChatsIntro`.
use butler_ds::ui::blocks::message_row::MessageBubble;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{AlignSelf, Space, Stack, WithItem as _};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::TranscriptCtx;

/// conversation.chatsIntro
fn chats_intro_text(lang: Lang) -> &'static str {
    match lang {
        Lang::Ko => "이제 여기선 편하게 얘기해요. 길어지는 건 문서로 드릴게요.",
        Lang::En => "You can talk to me casually here. Anything long, I'll send as a document.",
    }
}

/// The chats intro row.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn chats_intro(_t: &TranscriptCtx, _window: &mut Window, cx: &mut App) -> AnyElement {
    let text = chats_intro_text(Ds::get(cx).lang());
    Stack::new()
        .align_self(AlignSelf::Stretch)
        .gap(Space::Lg)
        .child(MessageBubble::new().child(Typo::body(text)))
        .into_any_element()
}
