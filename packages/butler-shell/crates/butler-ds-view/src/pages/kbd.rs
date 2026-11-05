//! Kbd.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::kbd::{Kbd, KbdSize};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, Styled as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::outline_button;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Shortcut hint",
            render: hint,
        },
        Story {
            name: "Inside a button",
            render: in_button,
        },
        Story {
            name: "Sizes and single keys",
            render: sizes,
        },
    ]
}

fn hint(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    use gpui::ParentElement as _;
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .wrap(true)
        .child(Typo::caption(lang.pick("Press", "누르면")).tone(Tone::Secondary))
        .child(Kbd::new(["⌘", "K"]))
        .child(
            Typo::caption(lang.pick("to search, Esc to close.", "검색하고, Esc로 닫습니다."))
                .tone(Tone::Secondary),
        )
        .into_any_element()
}

fn in_button(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    use gpui::ParentElement as _;
    let ds = Ds::get(cx);
    let search = gpui::div()
        .flex()
        .child(icon(Icon::Search, IconSize::Md, ds))
        .into_any_element();
    let key = Kbd::new(["⌘", "K"]).size(KbdSize::Sm).into_any_element();
    // Button `iconStart` and `iconEnd`: the icon, the label, then the shortcut.
    outline_button(
        "kbd-search",
        lang.pick("Search", "검색"),
        false,
        Some(search),
        Some(key),
        |_, _, _| {},
        cx,
    )
}

fn sizes(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    use gpui::ParentElement as _;
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Md)
        .wrap(true)
        .child(Kbd::new(["/"]))
        .child(Kbd::new(["Esc"]))
        .child(Kbd::new(["⇧", "Enter"]).size(KbdSize::Sm))
        .child(Kbd::new(["Ctrl", "K"]).size(KbdSize::Sm))
        .into_any_element()
}
