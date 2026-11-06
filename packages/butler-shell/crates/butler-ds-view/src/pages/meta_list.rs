//! MetaList.showcase.tsx.
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::meta_list::{MetaItem, MetaList};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Usage row",
            render: usage,
        },
        Story {
            name: "Value-only entry",
            render: value_only,
        },
    ]
}

fn usage(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (title, input, cache, output) = lang.pick(
        ("conversation", "Input", "Cache", "Output"),
        ("대화", "입력", "캐시", "출력"),
    );
    Stack::new()
        .gap(Space::Xs)
        .child(Typo::body(title))
        .child(MetaList::new([
            MetaItem::new(input, "36,460"),
            MetaItem::new(cache, "8,200"),
            MetaItem::new(output, "4,420"),
        ]))
        .into_any_element()
}

fn value_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (source, requests, plan) = lang.pick(
        ("Local telemetry", "Requests", "Plan"),
        ("로컬 원격 측정", "요청", "플랜"),
    );
    MetaList::new([
        MetaItem::value(source),
        MetaItem::new(requests, "24"),
        MetaItem::new(plan, "Pro"),
    ])
    .into_any_element()
}
