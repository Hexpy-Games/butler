//! Stack.showcase.tsx.
use butler_ds::ui::layout::{
    Align, Basis, Cross, MinWidth, Space, Stack, StackItem, WithItem as _,
};
use butler_ds::ui::tag::Tag;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use butler_ds::ui::button::{Button, Size, Variant};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Column",
            render: |lang, _, _| column(lang),
        },
        Story {
            name: "Row",
            render: |lang, _, _| row(lang),
        },
        Story {
            name: "Item grow, basis and shrink",
            render: |_, _, _| items(),
        },
        Story {
            name: "Truncation in a row",
            render: truncation,
        },
        Story {
            name: "Inline runs, lists and window drag",
            render: runs,
        },
    ]
}

fn three(lang: Lang) -> [Typo; 3] {
    [
        Typo::body(lang.pick("First", "첫째")),
        Typo::body(lang.pick("Second", "둘째")),
        Typo::body(lang.pick("Third", "셋째")),
    ]
}

fn column(lang: Lang) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .children(three(lang))
        .into_any_element()
}

fn row(lang: Lang) -> AnyElement {
    Stack::row()
        .gap(Space::Md)
        .cross(Cross::Center)
        .children(three(lang))
        .into_any_element()
}

fn items() -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .child(StackItem::new().grow().child(Tag::new("tag", "grow")))
                .child(
                    StackItem::new()
                        .shrink(false)
                        .child(Tag::new("tag", "shrink={false}")),
                ),
        )
        .child(
            Stack::row()
                .gap(Space::Sm)
                .wrap(true)
                .child(
                    StackItem::new()
                        .grow()
                        .basis(Basis::Md)
                        .min_width(MinWidth::Zero)
                        .child(Tag::new("tag", "basis=md")),
                )
                .child(
                    StackItem::new()
                        .grow()
                        .basis(Basis::Md)
                        .min_width(MinWidth::Zero)
                        .child(Tag::new("tag", "basis=md")),
                ),
        )
        .into_any_element()
}

fn truncation(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let title = lang.pick(
        "Desktop client polish for the dashboard and the settings screens",
        "대시보드와 설정 화면을 다듬는 데스크톱 클라이언트 작업",
    );
    let meta = lang.pick("Updated 2 minutes ago", "2분 전 업데이트");
    let action = lang.pick("Open", "열기");
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(
            Stack::new()
                .gap(Space::None)
                .grow()
                .min_width(MinWidth::Zero)
                .child(Typo::body(title).truncate())
                .child(Typo::caption(meta).tone(Tone::Secondary).truncate()),
        )
        .child(
            StackItem::new().shrink(false).child(
                Button::new("stack-open")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(action)
                    .on_click(|_, _, _| {}),
            ),
        )
        .into_any_element()
}

fn runs(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let list = |text: &'static str| Typo::body(text);
    Stack::new()
        .gap(Space::Md)
        .child(
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Sm)
                .min_width(MinWidth::Zero)
                .child(Typo::text("Butler site").truncate())
                .child(Typo::text("worktree · main").tone(Tone::Secondary).truncate()),
        )
        .child(
            Stack::new()
                .gap(Space::Xs)
                .child(list("Lists laid out as stacks carry no bullets or indent."))
                .child(list("Use as=\"ol\" or as=\"ul\" for the semantics.")),
        )
        .child(
            Stack::new()
                .align(Align::Row)
                .cross(Cross::Center)
                .window_drag(butler_ds::ui::layout::WindowDrag::Drag)
                .child(Typo::caption(
                    "windowDrag=\"drag\" makes a titlebar region draggable; buttons inside stay clickable.",
                ).tone(Tone::Secondary))
                .child(Button::new("stack-back").variant(Variant::Outline).size(Size::Sm).text("Back").on_click(|_, _, _| {})),
        )
        .into_any_element()
}
