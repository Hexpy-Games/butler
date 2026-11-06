//! Presence.showcase.tsx: a card that enters and exits on a toggle.
use butler_ds::ui::card::Card;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::presence::{Presence, PresenceMotion};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window, div};

use butler_ds::ui::button::{Button, Variant};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Rise",
            render: |lang, window, cx| {
                demo("presence-rise", PresenceMotion::Rise, lang, window, cx)
            },
        },
        Story {
            name: "Fade",
            render: |lang, window, cx| {
                demo("presence-fade", PresenceMotion::Fade, lang, window, cx)
            },
        },
    ]
}

fn demo(
    id: &'static str,
    motion: PresenceMotion,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let present = window.use_keyed_state(id, cx, |_, _| true);
    let on = *present.read(cx);
    let label = if on {
        lang.pick("Hide", "숨기기")
    } else {
        lang.pick("Show", "보이기")
    };
    let body = lang.pick(
        "Enters with a fade and a small rise, exits faster.",
        "살짝 떠오르며 나타나고 더 빨리 사라집니다.",
    );
    let toggle = Button::new(format!("{id}-toggle"))
        .variant(Variant::Outline)
        .text(label)
        .on_click(move |_, _, cx| {
            present.update(cx, |on, cx| {
                *on = !*on;
                cx.notify();
            });
        });
    Stack::new()
        .gap(Space::Md)
        .child(toggle)
        .child(
            Presence::new(format!("{id}-presence"), on)
                .motion(motion)
                .child(div().child(Card::new(format!("{id}-card")).child(Typo::body(body)))),
        )
        .into_any_element()
}
