//! Avatar.showcase.tsx. The "Sidebar row" story draws the rows with the NavRow stand-in and a
//! plain frame for SidebarShell (blocks of a later batch).
use butler_ds::tokens::Density;
use butler_ds::ui::Icon;
use butler_ds::ui::avatar::{Avatar, AvatarSize, AvatarTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::card::Card;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, Inline, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins_nav::{NavRow, sidebar_shell};

struct Copy {
    me: &'static str,
    minji: &'static str,
    dohyun: &'static str,
    elodie: &'static str,
    me_tip: &'static str,
    minji_tip: &'static str,
    working: &'static str,
    task: &'static str,
    task2: &'static str,
    caption: &'static str,
    toggle: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            me: "Harin",
            minji: "minji",
            dohyun: "Dohyun",
            elodie: "Élodie",
            me_tip: "Harin (me)",
            minji_tip: "minji",
            working: "Harin · Claude Code working",
            task: "Visualization blocks",
            task2: "Docs",
            caption: "2nd · Tasks 1/3",
            toggle: "Toggle agent",
        },
        Copy {
            me: "하린",
            minji: "minji",
            dohyun: "도현",
            elodie: "Élodie",
            me_tip: "하린 (나)",
            minji_tip: "minji 님",
            working: "하린 · Claude Code 작업 중",
            task: "시각화 블록",
            task2: "문서",
            caption: "2번째 · 작업 1/3",
            toggle: "에이전트 표시 바꾸기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sizes and tones",
            render: sizes_and_tones,
        },
        Story {
            name: "Initials from names",
            render: initials,
        },
        Story {
            name: "Agent badge",
            render: badge_toggle,
        },
        Story {
            name: "Sidebar row",
            render: sidebar_row,
        },
        Story {
            name: "Card title",
            render: card_title,
        },
    ]
}

const SIZES: [AvatarSize; 3] = [AvatarSize::Xs, AvatarSize::Sm, AvatarSize::Md];

fn sizes_and_tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let row = |tone: AvatarTone, name: &'static str| {
        Inline::new().gap(Space::Md).children(SIZES.map(|size| {
            Avatar::new(format!("avatar-{tone:?}-{size:?}"), name)
                .size(size)
                .tone(tone)
        }))
    };
    Stack::new()
        .gap(Space::Md)
        .child(row(AvatarTone::Own, c.me))
        .child(row(AvatarTone::Other, c.minji))
        .into_any_element()
}

fn initials(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .gap(Space::Md)
        .child(
            Avatar::new("avatar-init-me", c.me)
                .size(AvatarSize::Md)
                .label(c.me_tip),
        )
        .children([c.minji, c.dohyun, c.elodie].map(|name| {
            Avatar::new(format!("avatar-init-{name}"), name)
                .size(AvatarSize::Md)
                .tone(AvatarTone::Other)
        }))
        .into_any_element()
}

fn badge_toggle(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let working = window.use_keyed_state("avatar-working", cx, |_, _| true);
    let on = *working.read(cx);
    Stack::new()
        .gap(Space::Md)
        .child(Inline::new().gap(Space::Md).children(SIZES.map(|size| {
            Avatar::new(format!("avatar-badge-{size:?}"), c.me)
                .size(size)
                .label(if on { c.working } else { c.me_tip })
                .badge(on.then_some(Icon::Bot))
        })))
        .child(
            Stack::row().child(
                Button::new("avatar-toggle")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(c.toggle)
                    .on_click(move |_, _, cx| {
                        working.update(cx, |on, cx| {
                            *on = !*on;
                            cx.notify();
                        });
                    }),
            ),
        )
        .into_any_element()
}

/// A title with its assignee right after it; the title truncates first.
fn title_with_avatar(title: &'static str, avatar: Avatar) -> AnyElement {
    Stack::row()
        .gap(Space::Xs)
        .cross(Cross::Center)
        .child(Typo::text(title).truncate())
        .child(avatar)
        .into_any_element()
}

fn sidebar_row(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let status = IconSlot::new()
        .size(SlotSize::Sidebar)
        .min_line()
        .child(Spinner::new("avatar-sidebar-spinner"));
    let rows = [
        NavRow::new("avatar-nav-1", c.task)
            // SidebarShell sets `data-sidebar-density="comfortable"` on its root.
            .density(Density::Comfortable)
            .active()
            .glyph(Icon::Notebook, cx)
            .content(title_with_avatar(
                c.task,
                Avatar::new("avatar-nav-me", c.me)
                    .label(c.working)
                    .badge(Some(Icon::Bot)),
            ))
            .actions(status)
            .build(cx),
        NavRow::new("avatar-nav-2", c.task2)
            // SidebarShell sets `data-sidebar-density="comfortable"` on its root.
            .density(Density::Comfortable)
            .glyph(Icon::Notebook, cx)
            .content(title_with_avatar(
                c.task2,
                Avatar::new("avatar-nav-other", c.minji)
                    .tone(AvatarTone::Other)
                    .label(c.minji_tip),
            ))
            .build(cx),
    ];
    sidebar_shell(rows, cx)
}

fn card_title(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    Card::new("avatar-card")
        .padding(butler_ds::ui::card::CardPadding::Sm)
        .child(
            Stack::new()
                .gap(Space::Xs)
                .child(
                    Stack::row()
                        .gap(Space::Sm)
                        .cross(Cross::Center)
                        .child(IconSlot::new().size(SlotSize::Sm).child(icon(
                            Icon::Circle,
                            IconSize::Sm,
                            ds,
                        )))
                        .child(title_with_avatar(
                            c.task,
                            Avatar::new("avatar-card-me", c.me)
                                .label(c.working)
                                .badge(Some(Icon::Bot)),
                        )),
                )
                .child(Typo::caption(c.caption).tone(Tone::Secondary)),
        )
        .into_any_element()
}
