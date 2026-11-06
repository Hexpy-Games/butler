//! Clickable.showcase.tsx and Clickable.showcaseParts.tsx. SettingsSection and ProgressMeter
//! are stand-ins (`standins.rs`).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::clickable::{Bleed, Clickable, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{
    Box as DsBox, Cross, Inline, Justify, MinWidth, Space, Stack, WithItem as _,
};
use butler_ds::ui::typo::{Tone, Typo, Weight, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::{progress_bare, settings_status};

struct Automation {
    title: &'static str,
    target: &'static str,
    meta: &'static str,
}

struct Share {
    title: &'static str,
    description: &'static str,
    value: &'static str,
    percent: u32,
}

struct Copy {
    suggestion: &'static str,
    automations: [Automation; 2],
    artifact: &'static str,
    decision: &'static str,
    every: &'static str,
    usage: &'static str,
    chats: &'static str,
    task: &'static str,
    description: &'static str,
    shares: [Share; 3],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            suggestion: "Summarize today's changes",
            automations: [
                Automation { title: "Nightly release notes", target: "butler · main", meta: "active / Every day 07:00" },
                Automation { title: "Dependency audit", target: "butler-app", meta: "paused / Every Monday" },
            ],
            artifact: "Design review notes.md",
            decision: "Allow Butler to run the migration script against the staging database once the backup finishes",
            every: "Every hour",
            usage: "Usage",
            chats: "Top chats",
            task: "Tidy the release notes",
            description: "Collect the changes and review the release notes.",
            shares: [
                Share { title: "Release checklist", description: "Chat · 2h ago", value: "412K", percent: 46 },
                Share { title: "Weekly dependency audit", description: "Schedule · yesterday", value: "268K", percent: 30 },
                Share { title: "Design review notes", description: "Chat · Mon", value: "121K", percent: 14 },
            ],
        },
        Copy {
            suggestion: "오늘 변경 사항 요약하기",
            automations: [
                Automation { title: "야간 릴리스 노트", target: "butler · main", meta: "활성 / 매일 07:00" },
                Automation { title: "의존성 점검", target: "butler-app", meta: "일시 중지 / 매주 월요일" },
            ],
            artifact: "디자인 검토 메모.md",
            decision: "백업이 끝나면 스테이징 데이터베이스에 마이그레이션 스크립트를 실행하도록 버틀러에게 허용하기",
            every: "매시간",
            usage: "사용량",
            chats: "많이 쓴 대화",
            task: "릴리스 노트 정리",
            description: "변경 사항을 모아 릴리스 노트를 검토합니다.",
            shares: [
                Share { title: "릴리스 체크리스트", description: "대화 · 2시간 전", value: "412K", percent: 46 },
                Share { title: "주간 의존성 점검", description: "예약 작업 · 어제", value: "268K", percent: 30 },
                Share { title: "디자인 검토 메모", description: "대화 · 월", value: "121K", percent: 14 },
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Suggestion row",
            render: |lang, _, cx| suggestion(lang, false, cx),
        },
        Story {
            name: "Stretched list rows",
            render: stretched,
        },
        Story {
            name: "Toggle rows with inline bleed (settings card)",
            render: toggle_rows,
        },
        Story {
            name: "Editable fields with block bleed (task detail)",
            render: editable,
        },
        Story {
            name: "Artifact row",
            render: artifact,
        },
        Story {
            name: "Text variant (decision title)",
            render: text_variant,
        },
        Story {
            name: "Disabled",
            render: |lang, _, cx| suggestion(lang, true, cx),
        },
    ]
}

/// Prompt suggestion: an intrinsic-width icon and text row.
fn suggestion(lang: Lang, disabled: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let id = if disabled {
        "clickable-disabled"
    } else {
        "clickable-suggestion"
    };
    let mut row = Clickable::new(id)
        .on_click(|_, _, _| {})
        .child(icon(Icon::Sparkles, IconSize::Md, ds))
        .child(Typo::text(copy(lang).suggestion).truncate());
    if disabled {
        row = row.disabled();
    }
    row.into_any_element()
}

fn stretched(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let mut stack = Stack::new().gap(Space::Xs);
    for (index, automation) in c.automations.iter().enumerate() {
        stack = stack.child(
            Clickable::new(format!("clickable-automation-{index}"))
                .stretch()
                .on_click(|_, _, _| {})
                .child(
                    ListRow::new(automation.title)
                        .description(automation.target)
                        .meta(automation.meta),
                ),
        );
    }
    let ds = Ds::get(cx);
    stack
        .child(
            Clickable::new("clickable-every")
                .stretch()
                .on_click(|_, _, _| {})
                .child(
                    ListRow::new(c.automations[1].title)
                        .icon(icon(Icon::Clock3, IconSize::Md, ds))
                        .meta(c.every),
                ),
        )
        .into_any_element()
}

fn share_row(
    index: usize,
    share: &Share,
    selected: bool,
    cx: &mut App,
    state: &gpui::Entity<Option<usize>>,
) -> AnyElement {
    let state = state.clone();
    let body = Stack::new()
        .gap(Space::Xs)
        .child(
            Inline::new()
                .justify(Justify::Between)
                .cross(Cross::Start)
                .wrap(false)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .grow()
                        .min_width(MinWidth::Zero)
                        .child(Typo::body(share.title).tone(Tone::Primary).truncate())
                        .child(Typo::caption(share.description)),
                )
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .cross(Cross::End)
                        .child(Typo::body(share.value).tone(Tone::Primary).tabular())
                        .child(Typo::caption(format!("{}%", share.percent)).tabular()),
                ),
        )
        .child(progress_bare(share.percent as f32, cx));
    Clickable::new(format!("clickable-share-{index}"))
        .bleed(Bleed::Inline)
        .stretch()
        .selected(selected)
        .on_click(move |_, _, cx| {
            state.update(cx, |current, cx| {
                *current = if *current == Some(index) {
                    None
                } else {
                    Some(index)
                };
                cx.notify();
            });
        })
        .child(
            DsBox::new()
                .padding_y(Space::Sm)
                .grow()
                .min_width(MinWidth::Zero)
                .child(body),
        )
        .into_any_element()
}

fn toggle_rows(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let selected = window.use_keyed_state("clickable-share-selected", cx, |_, _| Some(0usize));
    let current = *selected.read(cx);
    let mut rows = Stack::new()
        .gap(Space::Xs)
        .child(Typo::label(c.chats).tone(Tone::Secondary));
    for (index, share) in c.shares.iter().enumerate() {
        rows = rows.child(share_row(
            index,
            share,
            current == Some(index),
            cx,
            &selected,
        ));
    }
    settings_status(c.usage, rows.into_any_element(), cx)
}

fn editable(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    DsBox::new()
        .padding(Space::Md)
        .child(
            Stack::new()
                .gap(Space::Lg)
                .child(
                    Clickable::new("clickable-edit-title")
                        .bleed(Bleed::Both)
                        .stretch()
                        .on_click(|_, _, _| {})
                        .child(
                            Stack::row()
                                .cross(Cross::Center)
                                .gap(Space::Xs)
                                .min_width(MinWidth::Zero)
                                .child(Typo::panel_title(c.task).wrap(Wrap::Anywhere))
                                .child(icon(Icon::Pencil, IconSize::Sm, ds)),
                        ),
                )
                .child(
                    Clickable::new("clickable-edit-description")
                        .bleed(Bleed::Both)
                        .stretch()
                        .on_click(|_, _, _| {})
                        .child(Typo::body(c.description).wrap(Wrap::Anywhere)),
                ),
        )
        .into_any_element()
}

fn artifact(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    Clickable::new("clickable-artifact")
        .on_click(|_, _, _| {})
        .child(ListRow::new(c.artifact).icon(icon(Icon::FileText, IconSize::Md, ds)))
        .into_any_element()
}

fn text_variant(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Clickable::new("clickable-text")
        .variant(Variant::Text)
        .on_click(|_, _, _| {})
        .child(
            Typo::label(copy(lang).decision)
                .weight(Weight::Medium)
                .tone(Tone::Primary)
                .line_clamp(2)
                .wrap(Wrap::Anywhere),
        )
        .into_any_element()
}
