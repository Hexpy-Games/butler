//! ArtifactList.showcase.tsx: message artifacts, the list at a card's width, and a row without
//! actions.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::artifact_list::{ArtifactAction, ArtifactItem, ArtifactList};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Message artifacts",
            render: message,
        },
        Story {
            name: "Card width",
            render: card_width,
        },
        Story {
            name: "Without actions",
            render: without_actions,
        },
    ]
}

struct Copy {
    save: &'static str,
    duplicate: &'static str,
    document: &'static str,
    image: &'static str,
    open: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            save: "Save",
            duplicate: "Copy",
            document: "document",
            image: "image",
            open: "Open",
        },
        Copy {
            save: "저장",
            duplicate: "복사",
            document: "문서",
            image: "이미지",
            open: "열기",
        },
    )
}

fn save(c: &Copy) -> ArtifactAction {
    ArtifactAction::new(c.save)
        .icon(Icon::Save)
        .on_click(|_, _, _| {})
}

fn message(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    ArtifactList::new("al-artifacts")
        .item(
            ArtifactItem::new("butler-dedicated-client-conversation.md")
                .description(format!("{} / 7.8 KB", c.document))
                .on_open(|_, _, _| {})
                .action(save(&c)),
        )
        .item(
            ArtifactItem::new("plan-butler-dedicated-client-functional-completion.md")
                .description(format!("{} / 5.2 KB", c.document))
                .on_open(|_, _, _| {})
                .action(save(&c)),
        )
        .item(
            ArtifactItem::new("settings-375.png")
                .description(format!("{} / 142 KB", c.image))
                .icon(Icon::ImageIcon)
                .on_open(|_, _, _| {})
                .action(save(&c)),
        )
        .into_any_element()
}

fn card_width(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let file = "quarterly-research-summary.md";
    let list = |id: &'static str, both: bool| {
        let mut item = ArtifactItem::new(file)
            .description(format!("{} / 6.1 KB", c.document))
            .on_open(|_, _, _| {})
            .action(save(&c));
        if both {
            item = item.action(
                ArtifactAction::new(c.duplicate)
                    .icon(Icon::Copy)
                    .on_click(|_, _, _| {}),
            );
        }
        ArtifactList::new(id).item(item)
    };
    Stack::new()
        .gap(Space::Lg)
        .children([240., 440.].map(|width| {
            div().max_w(px(width)).child(
                Stack::new()
                    .gap(Space::Md)
                    .child(list(
                        if width < 300. {
                            "al-w240-one"
                        } else {
                            "al-w440-one"
                        },
                        false,
                    ))
                    .child(list(
                        if width < 300. {
                            "al-w240-two"
                        } else {
                            "al-w440-two"
                        },
                        true,
                    )),
            )
        }))
        .into_any_element()
}

fn without_actions(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let _ = c.open;
    ArtifactList::new("al-readme")
        .item(
            ArtifactItem::new("README.md")
                .description(format!("{} / 2.1 KB", c.document))
                .on_open(|_, _, _| {}),
        )
        .into_any_element()
}
