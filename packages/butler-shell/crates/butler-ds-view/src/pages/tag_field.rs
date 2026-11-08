//! TagField.showcase.tsx: the field with two tags and existing tags to complete from, and the
//! empty field with its placeholder.
use butler_ds::ui::blocks::tag_field::{Suggestion, TagField};
use gpui::{AnyElement, App, IntoElement as _, SharedString, Window};

use super::{Story, sub};
use crate::copy::Lang;

struct Copy {
    label: &'static str,
    placeholder: &'static str,
    remove: fn(&str) -> String,
    create: fn(&str) -> String,
    value: [&'static str; 2],
    all: [(&'static str, u32); 6],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            label: "Tags",
            placeholder: "Add tag",
            remove: |n| format!("Remove {n}"),
            create: |n| format!("Create tag “{n}”"),
            value: ["jeju", "stays"],
            all: [
                ("cafés", 14),
                ("camping", 3),
                ("car rental", 2),
                ("jeju", 9),
                ("stays", 6),
                ("itinerary", 4),
            ],
        },
        Copy {
            label: "태그",
            placeholder: "태그 추가",
            remove: |n| format!("{n} 빼기"),
            create: |n| format!("‘{n}’ 태그 만들기"),
            value: ["제주", "숙소"],
            all: [
                ("카페", 14),
                ("캠핑", 3),
                ("카카오맵", 2),
                ("제주", 9),
                ("숙소", 6),
                ("일정", 4),
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "With tags (type to complete)",
            render: |lang, window, cx| demo(lang, "tf-tags", false, window, cx),
        },
        Story {
            name: "Empty with placeholder",
            render: |lang, window, cx| demo(lang, "tf-empty", true, window, cx),
        },
    ]
}

fn demo(
    lang: Lang,
    id: &'static str,
    empty: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let start: Vec<SharedString> = if empty {
        Vec::new()
    } else {
        c.value
            .iter()
            .map(|name| SharedString::from(*name))
            .collect()
    };
    let tags = window.use_keyed_state(sub(id, "value"), cx, move |_, _| start);
    let owner = tags.clone();
    let (remove, create) = (c.remove, c.create);
    TagField::new(sub(id, "field"), c.label)
        .value(tags.read(cx).clone(), move |next, _, cx| {
            owner.update(cx, |value, cx| {
                *value = next;
                cx.notify();
            });
        })
        .placeholder(c.placeholder)
        .remove_label(move |n| remove(n).into())
        .create_label(move |n| create(n).into())
        .suggestions(
            c.all
                .iter()
                .map(|(name, count)| Suggestion::new(*name).count(*count))
                .collect(),
        )
        .into_any_element()
}
