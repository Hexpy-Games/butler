//! Select.showcase.tsx. ProviderLogo is a stand-in (`standins_overlay.rs`); the state matrix
//! stories are not mirrored. The last story, "Scrolling list", is not in React: its list is
//! taller than the window, so the scroll buttons and the item-aligned scroll show. "Bottom sheet on phones" shows the anchored list until BottomSheet
//! (batch B5) provides the sheet presentation.
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::overlay::Presentation;
use butler_ds::ui::select::{Select, SelectContent, SelectItem, SelectTrigger};
use butler_ds::ui::select_button::{SelectButton, Size};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;
use crate::standins_overlay::provider_logo;

struct Copy {
    choose: &'static str,
    one: &'static str,
    two: &'static str,
    local: &'static str,
    worktree: &'static str,
    provider: &'static str,
    tags: &'static str,
    sites: &'static str,
    date: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            choose: "Choose",
            one: "One",
            two: "Two",
            local: "Local",
            worktree: "Worktree",
            provider: "Provider",
            tags: "Tags",
            sites: "Sites",
            date: "Date",
        },
        Copy {
            choose: "선택",
            one: "하나",
            two: "둘",
            local: "로컬",
            worktree: "워크트리",
            provider: "제공자",
            tags: "태그",
            sites: "사이트",
            date: "기간",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Default",
            render: default,
        },
        Story {
            name: "Disabled",
            render: disabled,
        },
        Story {
            name: "With icons (service logos)",
            render: providers,
        },
        Story {
            name: "Disabled option",
            render: disabled_option,
        },
        Story {
            name: "Filter triggers (SelectButton with count)",
            render: filters,
        },
        Story {
            name: "Bottom sheet on phones (presentation=\"auto\")",
            render: sheet,
        },
        Story {
            name: "Scrolling list",
            render: scrolling,
        },
    ]
}

/// The two-option list of `SelectExample`.
fn two(c: &Copy) -> SelectContent {
    SelectContent::new()
        .child(SelectItem::new("one", c.one))
        .child(SelectItem::new("two", c.two))
}

/// One `SelectExample`: a trigger and its list, with a marker naming the value it holds. They
/// are the stack's own children, as the trigger is the only box Radix Select renders.
fn example(
    id: &'static str,
    value: Option<&'static str>,
    c: &Copy,
    window: &mut Window,
    cx: &mut App,
) -> [AnyElement; 3] {
    let mut select = Select::new(id, window, cx);
    if let Some(value) = value {
        select = select.default_value(value, cx);
    }
    let content = two(c);
    let trigger = select.trigger(
        SelectTrigger::new(format!("{id}-trigger")).placeholder(c.choose),
        &content,
        cx,
    );
    let held = select
        .selected(cx)
        .map_or_else(|| "none".to_owned(), |value| value.to_string());
    [
        trigger,
        select.content(&content, window, cx),
        probe(format!("{id}-value-{held}")).into_any_element(),
    ]
}

fn default(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let first = example("select-value", Some("one"), &c, window, cx);
    let second = example("select-placeholder", None, &c, window, cx);
    Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .children(first)
        .children(second)
        .into_any_element()
}

fn disabled(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("select-off", window, cx)
        .default_value("one", cx)
        .disabled();
    let content = SelectContent::new().child(SelectItem::new("one", c.one));
    let trigger = select.trigger(
        SelectTrigger::new("select-off-trigger").placeholder(c.choose),
        &content,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(select.content(&content, window, cx))
        .into_any_element()
}

/// Settings > Models: each service keeps its logo in the list and the trigger.
fn providers(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("select-provider", window, cx).default_value("anthropic", cx);
    let mut content = SelectContent::new();
    for (value, label) in [
        ("openai", "OpenAI"),
        ("anthropic", "Anthropic"),
        ("google", "Google"),
    ] {
        content = content.child(SelectItem::new(value, label).icon(move || provider_logo(value)));
    }
    let trigger = select.trigger(
        SelectTrigger::new("select-provider-trigger").placeholder(c.provider),
        &content,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(select.content(&content, window, cx))
        .into_any_element()
}

/// Open it: the unavailable option keeps its place in the disabled tone and never takes the
/// hover fill.
fn disabled_option(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("select-workspace", window, cx).default_value("local", cx);
    let content = SelectContent::new()
        .child(SelectItem::new("local", c.local))
        .child(SelectItem::new("worktree", c.worktree).disabled());
    let trigger = select.trigger(SelectTrigger::new("select-workspace-trigger"), &content, cx);
    Stack::new()
        .child(trigger)
        .child(select.content(&content, window, cx))
        .into_any_element()
}

/// Library filter triggers: a count badge when values are chosen.
fn filters(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .child(
            SelectButton::new("filter-tags")
                .size(Size::Sm)
                .count(2)
                .text(c.tags),
        )
        .child(
            SelectButton::new("filter-sites")
                .size(Size::Sm)
                .text(c.sites),
        )
        .child(
            SelectButton::new("filter-date")
                .size(Size::Sm)
                .count(1)
                .text(c.date),
        )
        .into_any_element()
}

/// `presentation="auto"`: a BottomSheet below 768px, the anchored list above. The sheet is
/// batch B5's; here the list stays anchored.
fn sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("select-sheet", window, cx).default_value("one", cx);
    let content = two(&c).presentation(Presentation::Auto);
    let trigger = select.trigger(
        SelectTrigger::new("select-sheet-trigger").placeholder(c.choose),
        &content,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(select.content(&content, window, cx))
        .into_any_element()
}

/// Thirty options, the twentieth chosen.
fn scrolling(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("select-long", window, cx).default_value("item-20", cx);
    let mut content = SelectContent::new();
    for n in 1..=30 {
        content = content.child(SelectItem::new(
            format!("item-{n}"),
            format!("{} {n}", c.choose),
        ));
    }
    let trigger = select.trigger(SelectTrigger::new("select-long-trigger"), &content, cx);
    let held = select
        .selected(cx)
        .map_or_else(|| "none".to_owned(), |value| value.to_string());
    Stack::new()
        .child(trigger)
        .child(select.content(&content, window, cx))
        .child(probe(format!("select-long-value-{held}")))
        .into_any_element()
}
