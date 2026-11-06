//! UnreadDot.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, Space, Stack, WithItem as _};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::Typo;
use butler_ds::ui::unread_dot::UnreadDot;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    unread: &'static str,
    toggle: &'static str,
    chat: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            unread: "Unread",
            toggle: "Toggle unread",
            chat: "Weekly plan review",
        },
        Copy {
            unread: "읽지 않음",
            toggle: "읽음 상태 바꾸기",
            chat: "주간 계획 검토",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Enter and exit",
            render: enter_exit,
        },
        Story {
            name: "Sizes",
            render: sizes,
        },
        Story {
            name: "Trailing status column",
            render: status_column,
        },
    ]
}

fn chat_row(c: &Copy, mark: AnyElement, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(IconSlot::new().size(SlotSize::Sidebar).child(icon(
            Icon::MessageSquare,
            IconSize::Md,
            ds,
        )))
        .child(Typo::text(c.chat).grow().truncate())
        .child(mark)
        .into_any_element()
}

fn enter_exit(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let unread = window.use_keyed_state("unread-dot-toggle", cx, |_, _| true);
    let on = *unread.read(cx);
    let row = chat_row(
        &c,
        UnreadDot::new("unread-dot-enter", c.unread)
            .present(on)
            .into_any_element(),
        cx,
    );
    Stack::new()
        .gap(Space::Md)
        .child(row)
        .child(
            Stack::row().child(
                Button::new("unread-dot-toggle-button")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(c.toggle)
                    .on_click(move |_, _, cx| {
                        unread.update(cx, |on, cx| {
                            *on = !*on;
                            cx.notify();
                        });
                    }),
            ),
        )
        .into_any_element()
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Md)
        .child(UnreadDot::new("unread-dot-sm", c.unread).size(SlotSize::Sm))
        .child(UnreadDot::new("unread-dot-md", c.unread).size(SlotSize::Md))
        .child(UnreadDot::new("unread-dot-lg", c.unread).size(SlotSize::Lg))
        .into_any_element()
}

fn status_column(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let status = |child: AnyElement| {
        IconSlot::new()
            .size(SlotSize::Sidebar)
            .min_line()
            .child(child)
            .into_any_element()
    };
    let marks = [
        UnreadDot::new("unread-dot-column", c.unread).into_any_element(),
        status(Spinner::new("unread-dot-spinner").into_any_element()),
        status(icon(Icon::CircleAlert, IconSize::Md, ds).into_any_element()),
    ];
    Stack::new()
        .gap(Space::Sm)
        .children(marks.into_iter().map(|mark| chat_row(&c, mark, cx)))
        .into_any_element()
}
