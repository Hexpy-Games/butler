//! Collapsible.showcase.tsx. The tool row is a DisclosureRow stand-in (a block of a later batch).
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::collapsible::{Collapsible, CollapsibleList, Row};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, probe};
use crate::copy::Lang;
use crate::standins::disclosure_row;

struct Copy {
    toggle: &'static str,
    body: &'static str,
    tool: &'static str,
    output: &'static str,
    add: &'static str,
    remove: &'static str,
    rows: [&'static str; 5],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            toggle: "Toggle details",
            body: "Height reveals to auto with interpolate-size, then the text fades in.",
            tool: "Ran bun test",
            output: "42 pass, 0 fail",
            add: "Insert row",
            remove: "Remove row",
            rows: [
                "Desktop client polish",
                "Weekly review",
                "Travel plan",
                "Reading list",
                "Budget check",
            ],
        },
        Copy {
            toggle: "세부 정보 전환",
            body: "높이가 auto까지 부드럽게 열리고 텍스트가 서서히 나타납니다.",
            tool: "bun test 실행",
            output: "통과 42, 실패 0",
            add: "행 추가",
            remove: "행 삭제",
            rows: [
                "데스크톱 앱 다듬기",
                "주간 회고",
                "여행 계획",
                "읽을거리",
                "예산 점검",
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "List insert and remove",
            render: row_list,
        },
        Story {
            name: "Reveal",
            render: reveal,
        },
        Story {
            name: "Tool row",
            render: tool_row,
        },
    ]
}

/// A boolean held in the page's state, as the React stories' `useState`.
fn flag(
    id: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (bool, impl Fn(&mut App) + Clone + 'static) {
    let state = window.use_keyed_state(id, cx, |_, _| false);
    let on = *state.read(cx);
    (on, move |cx: &mut App| {
        state.update(cx, |on, cx| {
            *on = !*on;
            cx.notify();
        });
    })
}

fn reveal(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (open, toggle) = flag("collapsible-reveal", window, cx);
    Stack::new()
        .gap(Space::Sm)
        .child(
            Button::new("collapsible-reveal-toggle")
                .variant(Variant::Outline)
                .text(c.toggle)
                .on_click(move |_, _, cx| toggle(cx)),
        )
        .child(Collapsible::new("collapsible-reveal-body", open).child(Typo::body(c.body)))
        .child(probe(format!("open-reveal-{open}")))
        .into_any_element()
}

fn tool_row(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (open, toggle) = flag("collapsible-tool", window, cx);
    Stack::new()
        .child(disclosure_row(
            "collapsible-tool-row",
            Icon::Terminal,
            c.tool,
            open,
            Typo::caption(c.output).into_any_element(),
            move |cx| toggle(cx),
            cx,
        ))
        .child(probe(format!("open-tool-{open}")))
        .into_any_element()
}

/// The rows shown: `count` of them starting at `first` (Insert and Remove move both).
struct Shown {
    count: usize,
    first: usize,
}

fn row_list(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let state = window.use_keyed_state("collapsible-rows", cx, |_, _| Shown { count: 3, first: 0 });
    let (count, first) = {
        let s = state.read(cx);
        (s.count, s.first)
    };
    let total = c.rows.len();
    let (add, remove) = (state.clone(), state.clone());
    let rows = c.rows[first..(first + count).min(total)]
        .iter()
        .map(|label| {
            let label = SharedString::from(*label);
            Row::new(label.clone(), move |_, _| {
                Typo::body(label.clone()).into_any_element()
            })
        });
    Stack::new()
        .gap(Space::Sm)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .child(
                    Button::new("collapsible-insert")
                        .variant(Variant::Outline)
                        .text(c.add)
                        .on_click(move |_, _, cx| {
                            add.update(cx, |s, cx| {
                                if s.first > 0 {
                                    s.first -= 1;
                                } else {
                                    s.count = (s.count + 1).min(total);
                                }
                                cx.notify();
                            });
                        }),
                )
                .child(
                    Button::new("collapsible-remove")
                        .variant(Variant::Outline)
                        .text(c.remove)
                        .on_click(move |_, _, cx| {
                            remove.update(cx, |s, cx| {
                                s.first = (s.first + 1).min(total - 1);
                                s.count = s.count.saturating_sub(1).max(1);
                                cx.notify();
                            });
                        }),
                ),
        )
        .child(
            CollapsibleList::new("collapsible-list")
                .scope("rows")
                .gap(Space::Xs)
                .rows(rows),
        )
        .child(probe(format!("rows-{first}-{count}")))
        .into_any_element()
}
