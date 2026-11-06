//! Button.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant, container};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    create: &'static str,
    search: &'static str,
    more: &'static str,
    remove: &'static str,
    save: &'static str,
    details: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            create: "Create",
            search: "Search",
            more: "More",
            remove: "Delete",
            save: "Save changes",
            details: "Show details",
        },
        Copy {
            create: "만들기",
            search: "검색",
            more: "더 보기",
            remove: "삭제",
            save: "변경 사항 저장",
            details: "자세히 보기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Variants",
            render: variants,
        },
        Story {
            name: "Sizes",
            render: sizes,
        },
        Story {
            name: "Inline",
            render: inline,
        },
        Story {
            name: "Disabled",
            render: disabled,
        },
    ]
}

fn variants(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let (c, ds) = (copy(lang), Ds::get(cx));
    container(Size::Default)
        .child(
            Button::new("button-create")
                .icon_start(icon(Icon::Plus, IconSize::Md, ds))
                .text(c.create),
        )
        .child(
            Button::new("button-search")
                .variant(Variant::Outline)
                .icon_start(icon(Icon::Search, IconSize::Md, ds))
                .text(c.search),
        )
        .child(
            Button::new("button-more")
                .variant(Variant::Borderless)
                .icon_end(icon(Icon::Plus, IconSize::Md, ds))
                .text(c.more),
        )
        .child(
            Button::new("button-details")
                .variant(Variant::Ghost)
                .text(c.details),
        )
        .child(
            Button::new("button-delete")
                .variant(Variant::Destructive)
                .icon_start(icon(Icon::Trash2, IconSize::Md, ds))
                .text(c.remove),
        )
        .into_any_element()
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let save = copy(lang).save;
    container(Size::Default)
        .child(Button::new("button-xs").size(Size::Xs).text(save))
        .child(Button::new("button-sm").size(Size::Sm).text(save))
        .child(Button::new("button-md").text(save))
        .child(Button::new("button-lg").size(Size::Lg).text(save))
        .into_any_element()
}

fn inline(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Button::new("button-inline")
        .variant(Variant::Inline)
        .text(copy(lang).details)
        .into_any_element()
}

fn disabled(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    container(Size::Default)
        .child(Button::new("button-off").disabled().text(c.save))
        .child(
            Button::new("button-off-outline")
                .variant(Variant::Outline)
                .disabled()
                .text(c.search),
        )
        .child(
            Button::new("button-aria-off")
                .variant(Variant::Outline)
                .aria_disabled()
                .text(c.save),
        )
        .into_any_element()
}
