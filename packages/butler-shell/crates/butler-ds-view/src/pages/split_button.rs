//! SplitButton.showcase.tsx: an approval pair (Deny and a split Allow once), the outline split, a
//! split whose menu is unavailable, and the disabled pending state. The caller's last action shows
//! under the approval.
use butler_ds::ui::blocks::split_button::{SplitButton, SplitItem, SplitSize, SplitVariant};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::overlay::place::Side;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, sub};
use crate::copy::Lang;

struct Copy {
    deny: &'static str,
    once: &'static str,
    conversation: &'static str,
    scope: &'static str,
    note: &'static str,
    run: &'static str,
    later: &'static str,
    dry: &'static str,
    last: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            deny: "Deny",
            once: "Allow once",
            conversation: "Allow for this conversation",
            scope: "Write files in ~/projects/butler",
            note: "Butler will not ask again in this conversation.",
            run: "Run now",
            later: "Run in 10 minutes",
            dry: "Dry run",
            last: "Last action",
        },
        Copy {
            deny: "거부",
            once: "한 번 허용",
            conversation: "이 대화에서 허용",
            scope: "~/projects/butler 안의 파일 쓰기",
            note: "이 대화에서는 다시 묻지 않습니다.",
            run: "지금 실행",
            later: "10분 뒤 실행",
            dry: "시험 실행",
            last: "마지막 동작",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Approval (primary, small, menu above)",
            render: |lang, window, cx| approval(lang, "sb-approval", false, true, window, cx),
        },
        Story {
            name: "Outline",
            render: outline,
        },
        Story {
            name: "Menu unavailable",
            render: |lang, window, cx| approval(lang, "sb-unavailable", false, false, window, cx),
        },
        Story {
            name: "Disabled while pending",
            render: |lang, window, cx| approval(lang, "sb-pending", true, true, window, cx),
        },
    ]
}

fn remember(last: &Entity<SharedString>, text: &'static str) -> impl Fn(&mut App) + 'static {
    let last = last.clone();
    move |cx| {
        last.update(cx, |last, cx| {
            *last = text.into();
            cx.notify();
        });
    }
}

fn approval(
    lang: Lang,
    id: &'static str,
    pending: bool,
    scope: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let last = window.use_keyed_state(sub(id, "last"), cx, |_, _| SharedString::new_static("—"));
    let (deny, once, conversation) = (
        remember(&last, c.deny),
        remember(&last, c.once),
        remember(&last, c.conversation),
    );
    let mut deny_button = Button::new(sub(id, "deny"))
        .size(Size::Sm)
        .variant(Variant::Secondary)
        .text(c.deny)
        .on_click(move |_, _, cx| deny(cx));
    let mut split = SplitButton::new(format!("{id}-split"), c.once, move |_, _, cx| once(cx))
        .size(SplitSize::Sm)
        .menu_side(Side::Top);
    let mut item = SplitItem::new(c.conversation, move |_, cx| conversation(cx))
        .description([c.scope.into(), c.note.into()]);
    if !scope {
        item = item.disabled();
    }
    split = split.item(item);
    if pending {
        deny_button = deny_button.disabled();
        split = split.disabled();
    }
    let line = format!("{}: {}", c.last, last.read(cx));
    Stack::new()
        .gap(Space::Sm)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .justify(Justify::End)
                .wrap(true)
                .child(deny_button)
                .child(split),
        )
        .child(Typo::caption(line).tone(Tone::Secondary))
        .into_any_element()
}

fn outline(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SplitButton::new("sb-outline", c.run, |_, _, _| {})
        .variant(SplitVariant::Outline)
        .item(SplitItem::new(c.later, |_, _| {}))
        .item(SplitItem::new(c.dry, |_, _| {}))
        .into_any_element()
}
