//! KeyValueRow.showcase.tsx: branch details, a context legend with swatches, a legend linked to
//! a chart (hover and focus report the row) and a metadata grid. The state matrix (solid and
//! hatched swatch, default, hover, focus-visible) is covered by the live harness.
use butler_ds::tokens::Color;
use butler_ds::ui::blocks::key_value_row::{Detail, KeyValueRow, SwatchPattern, ValueSize};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Category {
    label: &'static str,
    description: &'static str,
    value: &'static str,
    meta: &'static str,
}

struct Copy {
    gateway: &'static str,
    ready: &'static str,
    branch: &'static str,
    workspace: &'static str,
    local: &'static str,
    changes: &'static str,
    clean: &'static str,
    categories: [Category; 3],
    provider: &'static str,
    runtime: &'static str,
    secrets: &'static str,
    redacted: &'static str,
    conversation: &'static str,
    subtask: &'static str,
    hint: &'static str,
    emphasized: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            gateway: "Gateway",
            ready: "Ready",
            branch: "Git branch",
            workspace: "Workspace",
            local: "Local",
            changes: "Changes",
            clean: "Clean",
            categories: [
                Category {
                    label: "System prompt",
                    description: "Instructions, tools and skills",
                    value: "12.4K",
                    meta: "18%",
                },
                Category {
                    label: "Conversation",
                    description: "Messages and tool results in this turn and the ones before it",
                    value: "38.1K",
                    meta: "54%",
                },
                Category {
                    label: "Files",
                    description: "Pinned project documents",
                    value: "6.2K",
                    meta: "9%",
                },
            ],
            provider: "Provider",
            runtime: "Runtime",
            secrets: "Secrets",
            redacted: "Redacted",
            conversation: "Conversation",
            subtask: "Subtask",
            hint: "Hover or focus a row",
            emphasized: "Chart emphasis: ",
        },
        Copy {
            gateway: "게이트웨이",
            ready: "준비됨",
            branch: "Git 브랜치",
            workspace: "작업 공간",
            local: "로컬",
            changes: "변경 사항",
            clean: "깨끗함",
            categories: [
                Category {
                    label: "시스템 프롬프트",
                    description: "지침, 도구, 스킬",
                    value: "12.4K",
                    meta: "18%",
                },
                Category {
                    label: "대화",
                    description: "이번 턴과 이전 턴의 메시지와 도구 결과",
                    value: "38.1K",
                    meta: "54%",
                },
                Category {
                    label: "파일",
                    description: "고정한 프로젝트 문서",
                    value: "6.2K",
                    meta: "9%",
                },
            ],
            provider: "제공자",
            runtime: "런타임",
            secrets: "비밀 값",
            redacted: "가려짐",
            conversation: "대화",
            subtask: "하위 작업",
            hint: "행에 마우스를 올리거나 포커스하세요",
            emphasized: "차트 강조: ",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Branch details",
            render: branch,
        },
        Story {
            name: "Context legend with swatches",
            render: legend,
        },
        Story {
            name: "Linked legend with hatched swatch",
            render: linked,
        },
        Story {
            name: "Metadata grid",
            render: grid,
        },
    ]
}

fn branch(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Xs)
        .child(KeyValueRow::new(c.gateway, c.ready))
        .child(KeyValueRow::new(c.branch, "ui/ds-viewer-complete"))
        .child(KeyValueRow::new(c.workspace, c.local))
        .child(KeyValueRow::new(c.changes, c.clean))
        .into_any_element()
}

fn legend(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let colors = [
        Color::ContextChart1,
        Color::ContextChart2,
        Color::ContextChart3,
    ];
    Stack::new()
        .gap(Space::Xs)
        .children(c.categories.iter().zip(colors).map(|(category, color)| {
            KeyValueRow::new(category.label, category.value)
                .description(category.description)
                .meta(category.meta)
                .detail(Detail::RowStart)
                .swatch_color(ds.color(color))
                .value_size(ValueSize::Caption)
        }))
        .into_any_element()
}

fn linked(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let highlighted = window.use_keyed_state("kv-highlighted", cx, |_, _| None::<&'static str>);
    let current = *highlighted.read(cx);
    let color = Ds::get(cx).color(Color::ContextChart5);
    let hint = match current {
        Some(label) => SharedString::from(format!("{}{label}", c.emphasized)),
        None => SharedString::from(c.hint),
    };
    let rows = [
        (
            c.conversation,
            "5.2K · 53.6%",
            SwatchPattern::Solid,
            "kv-solid",
        ),
        (
            c.subtask,
            "4.5K · 46.4%",
            SwatchPattern::Hatched,
            "kv-hatched",
        ),
    ]
    .map(|(label, value, pattern, id)| {
        let highlighted = highlighted.clone();
        KeyValueRow::new(label, value)
            .value_size(ValueSize::Caption)
            .swatch_color(color)
            .swatch_pattern(pattern)
            .on_highlight_change(id, move |on, _, cx| {
                highlighted.update(cx, |state, cx| {
                    *state = on.then_some(label);
                    cx.notify();
                });
            })
    });
    Stack::new()
        .gap(Space::Xs)
        .child(Typo::caption(hint).tone(Tone::Tertiary))
        .children(rows)
        .child(probe(format!("kv-highlight-{}", current.unwrap_or("none"))))
        .into_any_element()
}

fn grid(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Grid::new("kv-grid")
        .columns(Columns::fixed(2))
        .gap(Space::Sm)
        .child(KeyValueRow::new(c.provider, "openai"))
        .child(KeyValueRow::new(c.runtime, "responses"))
        .child(KeyValueRow::new(c.secrets, c.redacted).detail(Detail::Stack))
        .into_any_element()
}
