//! `ChatsIntro` and `useChatsIntroVisible`: the first-run line in the general chat. It shows
//! while the settings say it was never seen, and stays for the rest of the run once it has
//! shown, marking itself seen with a settings PATCH.
use butler_ds::ui::blocks::message_row::MessageBubble;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{AlignSelf, Space, Stack, WithItem as _};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, Global, IntoElement as _, ParentElement as _, Window};

use super::TranscriptCtx;
use crate::ui::i18n::transcript;
use crate::ui::source::agent::Jobs;

/// What the settings say (`settings.chats_intro_seen`; unknown until loaded) and whether the
/// intro has shown this run (`useIntroSession`).
#[derive(Default)]
struct Intro {
    seen: Option<bool>,
    shown: bool,
}

impl Global for Intro {}

/// The settings' `chats_intro_seen`, once loaded.
pub(crate) fn set_seen(cx: &mut App, seen: bool) {
    cx.default_global::<Intro>().seen = Some(seen);
}

/// `useChatsIntroVisible`.
pub(super) fn visible(session: &str, cx: &App) -> bool {
    let intro = cx.try_global::<Intro>();
    session == "general"
        && intro.is_some_and(|intro| intro.shown || intro.seen == Some(false))
}

/// The first showing marks the intro seen (`ChatsIntro`'s effect).
fn mark_shown(cx: &mut App) {
    let intro = cx.default_global::<Intro>();
    if intro.shown {
        return;
    }
    intro.shown = true;
    let request = Jobs::run(cx, |client| async move {
        client
            .update_settings(&serde_json::json!({"chats_intro_seen": true}))
            .await
    });
    let failed = transcript(Ds::get(cx).lang()).save_failed;
    cx.spawn(async move |cx| {
        if let Some(Err(_)) = request.await {
            cx.update(|cx| toast::show(cx, Toast::error(failed)));
        }
    })
    .detach();
}

/// The chats intro row.
pub(crate) fn chats_intro(_t: &TranscriptCtx, _window: &mut Window, cx: &mut App) -> AnyElement {
    mark_shown(cx);
    let text = transcript(Ds::get(cx).lang()).chats_intro;
    Stack::new()
        .align_self(AlignSelf::Stretch)
        .gap(Space::Lg)
        .child(MessageBubble::new().child(Typo::body(text)))
        .into_any_element()
}
