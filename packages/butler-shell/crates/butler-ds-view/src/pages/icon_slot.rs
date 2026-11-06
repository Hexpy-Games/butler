//! IconSlot.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, Space, Stack, WithItem as _};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sizes",
            render: sizes,
        },
        Story {
            name: "Row glyph and status mark",
            render: row,
        },
    ]
}

fn sizes(_: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let slot = |size, glyph| {
        IconSlot::new()
            .size(size)
            .child(icon(Icon::Folder, glyph, ds))
    };
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Md)
        .child(slot(SlotSize::Xs, IconSize::Xs))
        .child(slot(SlotSize::Sm, IconSize::Sm))
        .child(slot(SlotSize::Md, IconSize::Md))
        .child(slot(SlotSize::Lg, IconSize::Lg))
        .into_any_element()
}

fn row(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let project = lang.pick("Butler site", "버틀러 사이트");
    let status = || IconSlot::new().size(SlotSize::Sidebar).min_line();
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(IconSlot::new().size(SlotSize::Sidebar).child(icon(
            Icon::Briefcase,
            IconSize::Md,
            ds,
        )))
        .child(Typo::text(project).grow().truncate())
        .child(status().child(Spinner::new("icon-slot-spinner")))
        .child(status().child(icon(Icon::CircleAlert, IconSize::Md, ds)))
        .child(IconSlot::new().size(SlotSize::Sidebar).child(icon(
            Icon::MessageSquare,
            IconSize::Md,
            ds,
        )))
        .into_any_element()
}
