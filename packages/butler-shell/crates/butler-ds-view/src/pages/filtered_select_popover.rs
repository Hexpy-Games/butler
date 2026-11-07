//! FilteredSelectPopover.showcase.tsx: the model picker (provider filters, grouped results and a
//! reasoning footer), a searchable select at a fixed width and 6.5 rows, and rows with their own
//! edit menu beside the select button. Each popover body is drawn in place, as the React stories do.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::filtered_select_popover::{
    Filter, FilteredSelectPopover, FooterOption, Group, Item, Width,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item as MenuItem, Variant};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::tag::{LabelTone, Tag, Tone};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window, div,
};

use super::Story;
use crate::copy::Lang;

struct Copy {
    model: &'static str,
    placeholder: &'static str,
    empty: &'static str,
    all: &'static str,
    local: &'static str,
    reasoning: &'static str,
    levels: [&'static str; 4],
    context: fn(&str) -> String,
    timezone: &'static str,
    zones: [&'static str; 4],
    tags: &'static str,
    tag_placeholder: &'static str,
    no_tags: &'static str,
    tag_names: [&'static str; 3],
    rename: &'static str,
    recolor: &'static str,
    remove: &'static str,
    tag_menu: fn(&str) -> String,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            model: "Model",
            placeholder: "Search models…",
            empty: "No models found",
            all: "All",
            local: "Local",
            reasoning: "Reasoning",
            levels: ["Instant", "Low", "Medium", "High"],
            context: |size| format!("{size} API context"),
            timezone: "Time zone",
            zones: ["Asia/Seoul", "America/Los_Angeles", "Europe/Berlin", "UTC"],
            tags: "Tags",
            tag_placeholder: "Search tags…",
            no_tags: "No tags",
            tag_names: ["bug", "design", "research"],
            rename: "Rename",
            recolor: "Change color",
            remove: "Delete",
            tag_menu: |name| format!("{name} tag menu"),
        },
        Copy {
            model: "모델",
            placeholder: "모델 검색…",
            empty: "모델이 없습니다",
            all: "전체",
            local: "로컬",
            reasoning: "추론",
            levels: ["즉시", "낮음", "보통", "높음"],
            context: |size| format!("API 컨텍스트 {size}"),
            timezone: "시간대",
            zones: ["Asia/Seoul", "America/Los_Angeles", "Europe/Berlin", "UTC"],
            tags: "태그",
            tag_placeholder: "태그 검색…",
            no_tags: "태그가 없습니다",
            tag_names: ["버그", "디자인", "조사"],
            rename: "이름 바꾸기",
            recolor: "색 바꾸기",
            remove: "삭제",
            tag_menu: |name| format!("{name} 태그 메뉴"),
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Model picker",
            render: model_picker,
        },
        Story {
            name: "Searchable select (fixed width)",
            render: time_zone,
        },
        Story {
            name: "Rows with actions",
            render: tag_picker,
        },
    ]
}

/// `set(value)`: a handler that stores into an entity and repaints.
fn setter<T: Clone + 'static>(
    state: &Entity<T>,
    value: T,
) -> impl Fn(&mut Window, &mut App) + 'static {
    let state = state.clone();
    move |_, cx| {
        state.update(cx, |state, cx| {
            *state = value.clone();
            cx.notify();
        });
    }
}

fn matches(label: &str, query: &str) -> bool {
    label.to_lowercase().contains(&query.to_lowercase())
}

/// The search-change callback: stores the typed text in `query` and repaints.
fn query_setter(query: &Entity<SharedString>) -> impl Fn(&str, &mut Window, &mut App) + 'static {
    let query = query.clone();
    move |text, _, cx| {
        let text = SharedString::from(text.to_owned());
        query.update(cx, |query, cx| {
            *query = text;
            cx.notify();
        });
    }
}

fn model_picker(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let query: Entity<SharedString> =
        window.use_keyed_state("fsp-model-query", cx, |_, _| SharedString::default());
    let filter: Entity<SharedString> =
        window.use_keyed_state("fsp-model-filter", cx, |_, _| "all".into());
    let model: Entity<SharedString> =
        window.use_keyed_state("fsp-model", cx, |_, _| "model-1".into());
    let reasoning: Entity<usize> = window.use_keyed_state("fsp-model-reasoning", cx, |_, _| 2);
    let (q, active, chosen, level) = (
        query.read(cx).clone(),
        filter.read(cx).clone(),
        model.read(cx).clone(),
        *reasoning.read(cx),
    );
    let ds = Ds::get(cx);
    let rows = |entries: &[(&'static str, &'static str, &'static str)], glyph: Icon| -> Vec<Item> {
        entries
            .iter()
            .filter(|(_, label, _)| matches(label, &q))
            .map(|(id, label, size)| {
                Item::new(*id, *label)
                    .icon(icon(glyph, IconSize::Md, ds))
                    .description((c.context)(size))
                    .selected(chosen == *id)
                    .on_select(setter(&model, SharedString::from(*id)))
            })
            .collect()
    };
    let openai = rows(
        &[
            ("model-1", "Model 5.1", "1.05M"),
            ("model-2", "Model mini", "400K"),
        ],
        Icon::Bot,
    );
    let local = rows(&[("model-3", "Coder 14B", "32K")], Icon::Sparkles);
    let groups = vec![
        Group::new(
            "openai",
            "OpenAI",
            if active == "local" {
                Vec::new()
            } else {
                openai
            },
        ),
        Group::new(
            "local",
            c.local,
            if active == "openai" {
                Vec::new()
            } else {
                local
            },
        ),
    ];
    let filters = [("all", c.all), ("openai", "OpenAI"), ("local", c.local)]
        .into_iter()
        .map(|(id, label)| Filter::new(id, label, setter(&filter, SharedString::from(id))))
        .collect();
    let footer = c
        .levels
        .iter()
        .enumerate()
        .map(|(index, label)| FooterOption::new(*label, level == index, setter(&reasoning, index)))
        .collect();
    FilteredSelectPopover::new("fsp-model-popover", c.model, c.placeholder, c.empty)
        .search(q, query_setter(&query))
        .filters(filters, active)
        .groups(groups)
        .footer(Some(c.reasoning.into()), footer)
        .into_any_element()
}

fn time_zone(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let query: Entity<SharedString> =
        window.use_keyed_state("fsp-zone-query", cx, |_, _| SharedString::default());
    let zone: Entity<SharedString> =
        window.use_keyed_state("fsp-zone", cx, |_, _| "Asia/Seoul".into());
    let (q, chosen) = (query.read(cx).clone(), zone.read(cx).clone());
    let items = c
        .zones
        .iter()
        .filter(|id| matches(id, &q))
        .map(|id| {
            Item::new(*id, *id)
                .selected(chosen == *id)
                .on_select(setter(&zone, SharedString::from(*id)))
        })
        .collect();
    let set_query = query.clone();
    FilteredSelectPopover::new("fsp-zone-popover", c.timezone, c.timezone, c.empty)
        .search(q, move |text, _, cx| {
            let text = SharedString::from(text.to_owned());
            set_query.update(cx, |query, cx| {
                *query = text;
                cx.notify();
            });
        })
        .filters(vec![Filter::new("all", c.all, |_, _| {})], "all")
        .groups(vec![Group::new("zones", c.all, items)])
        .results_max_rows(6.5)
        .width(Width::Fixed)
        .into_any_element()
}

fn tag_picker(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let query: Entity<SharedString> =
        window.use_keyed_state("fsp-tag-query", cx, |_, _| SharedString::default());
    let chosen: Entity<Vec<usize>> = window.use_keyed_state("fsp-tag-chosen", cx, |_, _| vec![1]);
    let q = query.read(cx).clone();
    let picked = chosen.read(cx).clone();
    let tones = [LabelTone::Red, LabelTone::Teal, LabelTone::Purple];
    let mut items = Vec::new();
    for (index, name) in c
        .tag_names
        .iter()
        .enumerate()
        .filter(|(_, name)| matches(name, &q))
    {
        let menu = DropdownMenu::new(format!("fsp-tag-menu-{index}"), window, cx);
        let ds = Ds::get(cx);
        let trigger = menu.trigger(|toggle| {
            IconButton::new(format!("fsp-tag-edit-{index}"), (c.tag_menu)(name))
                .icon(icon(Icon::Pencil, IconSize::Sm, ds))
                .menu_trigger()
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let content = menu.content(
            DropdownMenuContent::new()
                .align(Align::End)
                .side_offset(8.)
                .child(MenuItem::new(c.rename))
                .child(MenuItem::new(c.recolor))
                .child(MenuItem::new(c.remove).variant(Variant::Destructive)),
            window,
            cx,
        );
        let toggle = chosen.clone();
        let select = Rc::new(move |_: &mut Window, cx: &mut App| {
            toggle.update(cx, |value, cx| {
                if let Some(at) = value.iter().position(|item| *item == index) {
                    value.remove(at);
                } else {
                    value.push(index);
                }
                cx.notify();
            });
        });
        items.push(
            Item::new(
                *name,
                Tag::new(format!("fsp-tag-{index}"), *name).tone(Tone::Label(tones[index])),
            )
            .selected(picked.contains(&index))
            .on_select(move |window, cx| select(window, cx))
            .actions(div().child(trigger).child(content)),
        );
    }
    let set_query = query.clone();
    FilteredSelectPopover::new("fsp-tag-popover", c.tags, c.tag_placeholder, c.no_tags)
        .search(q, move |text, _, cx| {
            let text = SharedString::from(text.to_owned());
            set_query.update(cx, |query, cx| {
                *query = text;
                cx.notify();
            });
        })
        .groups(vec![Group::new("tags", c.tags, items)])
        .into_any_element()
}
