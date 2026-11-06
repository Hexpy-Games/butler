//! SegmentedControl.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    period: &'static str,
    days: fn(u32) -> String,
    kind: &'static str,
    work: &'static str,
    plan: &'static str,
    task: &'static str,
    views: &'static str,
    all: &'static str,
    recent: &'static str,
    running: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            period: "Period",
            days: |days| format!("Last {days} days"),
            kind: "Board kind",
            work: "Work",
            plan: "Plan",
            task: "Task",
            views: "Conversation view",
            all: "All",
            recent: "Recent",
            running: "Running",
        },
        Copy {
            period: "기간",
            days: |days| format!("최근 {days}일"),
            kind: "보드 종류",
            work: "작업",
            plan: "계획",
            task: "할 일",
            views: "대화 보기",
            all: "전체보기",
            recent: "최신",
            running: "진행중",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Period",
            render: |lang, window, cx| period("segmented-period", Size::Default, lang, window, cx),
        },
        Story {
            name: "List filter (stretch, icons)",
            render: filter,
        },
        Story {
            name: "Small",
            render: |lang, window, cx| period("segmented-small", Size::Sm, lang, window, cx),
        },
        Story {
            name: "Disabled option",
            render: kind,
        },
    ]
}

/// A controlled value held in the page's state, as the React stories' `useState`.
fn chosen(
    id: &'static str,
    initial: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (SharedString, impl Fn(&str, &mut Window, &mut App) + 'static) {
    let state = window.use_keyed_state(id, cx, move |_, _| SharedString::from(initial));
    let value = state.read(cx).clone();
    (value, move |next: &str, _: &mut Window, cx: &mut App| {
        let next = SharedString::from(next.to_owned());
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
    })
}

fn period(
    id: &'static str,
    size: Size,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let (value, change) = chosen(id, "30", window, cx);
    let days: u32 = value.parse().unwrap_or(30);
    Stack::new()
        .gap(Space::Sm)
        .child(
            SegmentedControl::new(id, c.period, value)
                .size(size)
                .options([7, 30, 90].map(|d| Choice::new(d.to_string(), (c.days)(d))))
                .on_value_change(change),
        )
        .child(Typo::caption((c.days)(days)).tone(Tone::Secondary))
        .child(probe(format!("value-{id}-{days}")))
        .into_any_element()
}

fn kind(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = chosen("segmented-kind", "work", window, cx);
    SegmentedControl::new("segmented-kind", c.kind, value)
        .options([
            Choice::new("work", c.work),
            Choice::new("plan", c.plan),
            Choice::new("task", c.task).disabled(),
        ])
        .on_value_change(change)
        .into_any_element()
}

fn filter(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = chosen("segmented-filter", "all", window, cx);
    SegmentedControl::new("segmented-filter", c.views, value)
        .stretch()
        .options([
            Choice::new("all", c.all).icon(Icon::ListFilter),
            Choice::new("recent", c.recent).icon(Icon::Clock3),
            Choice::new("running", c.running).icon(Icon::Activity),
        ])
        .on_value_change(change)
        .into_any_element()
}
