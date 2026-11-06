//! DisclosureRow.showcase.tsx (with DisclosureRow.showcaseParts.tsx): a tool call, a changed
//! file, source details, a log list and trace steps. The states matrix is covered by the live
//! harness (hover, focus, open).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::disclosure_row::{self, Affordance, Attention, DisclosureRow, Surface};
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::Story;
use super::nav_parts::flag;
use crate::copy::Lang;

struct Copy {
    search: &'static str,
    files: &'static str,
    result: &'static str,
    path: &'static str,
    counts: &'static str,
    details: &'static str,
    revision: &'static str,
    updated: &'static str,
    evidence: &'static str,
    log: &'static str,
    log_meta: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            search: "Search",
            files: "Project files",
            result: "Read-only file search completed: 14 matches in 6 files.",
            path: "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
            counts: "+12 −3",
            details: "Source details",
            revision: "Revision",
            updated: "Updated",
            evidence: "3 sources",
            log: "model_turn · turn-5.1",
            log_meta: "8 sections / 42K context chars / 3.1K response chars",
        },
        Copy {
            search: "검색",
            files: "프로젝트 파일",
            result: "읽기 전용 파일 검색 완료: 파일 6개에서 14건.",
            path: "packages/butler-app/client/ui/src/libs/design-system/tokens.css",
            counts: "+12 −3",
            details: "출처 정보",
            revision: "리비전",
            updated: "수정",
            evidence: "출처 3개",
            log: "model_turn · turn-5.1",
            log_meta: "섹션 8개 / 컨텍스트 4.2만 자 / 응답 3.1천 자",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Tool call (selection surface)",
            render: tool_call,
        },
        Story {
            name: "Changed file (plain)",
            render: changed_file,
        },
        Story {
            name: "Source details and developer log",
            render: source_details,
        },
        Story {
            name: "Log list (chevron after the title)",
            render: log_list,
        },
        Story {
            name: "Trace steps (no chevron, static and interactive)",
            render: trace_steps,
        },
    ]
}

/// `Toggle`: local open state; plain rows start closed like changed files and source details.
fn toggle(
    id: &'static str,
    initial: bool,
    row: DisclosureRow,
    window: &mut Window,
    cx: &mut App,
) -> DisclosureRow {
    let (open, on_toggle) = flag(id, initial, window, cx);
    row.open(open).on_toggle(on_toggle)
}

fn tool_call(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let row = DisclosureRow::new("dr-tool", c.search)
        .icon(icon(Icon::Wrench, IconSize::Md, ds))
        .description(c.files)
        .meta(c.evidence)
        .child(Typo::caption(c.result));
    toggle("dr-tool-open", true, row, window, cx).into_any_element()
}

fn changed_file(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let row = DisclosureRow::new("dr-file", c.path)
        .surface(Surface::Plain)
        .icon(icon(Icon::FileText, IconSize::Lg, ds))
        .meta(c.counts)
        .child(Typo::code("--motion-fast: 120ms;"));
    toggle("dr-file-open", false, row, window, cx).into_any_element()
}

fn source_details(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let details = DisclosureRow::new("dr-details", c.details)
        .surface(Surface::Plain)
        .child(
            Stack::new()
                .gap(Space::Xs)
                .child(KeyValueRow::new(c.revision, "r42").value_size(ValueSize::Caption))
                .child(KeyValueRow::new(c.updated, "2026-09-25").value_size(ValueSize::Caption)),
        );
    let log = DisclosureRow::new("dr-log", c.log)
        .description(c.files)
        .meta(c.log_meta)
        .child(Typo::caption(c.evidence));
    Stack::new()
        .gap(Space::Sm)
        .child(toggle("dr-details-open", false, details, window, cx))
        // `.root + .root { margin-top: var(--space-xs) }` on top of the stack's gap.
        .child(
            div()
                .mt(Ds::get(cx).len(butler_ds::tokens::Length::SpaceXs))
                .child(toggle("dr-log-open", true, log, window, cx)),
        )
        .into_any_element()
}

/// A log record: title, level, duration, description and facts.
struct Record {
    id: &'static str,
    title: (&'static str, &'static str),
    level: ((&'static str, &'static str), TagTone),
    duration: Option<&'static str>,
    description: (&'static str, &'static str),
    facts: &'static [((&'static str, &'static str), &'static str)],
}

const LOGS: [Record; 3] = [
    Record {
        id: "log_9f21",
        title: (
            "Send failed · 429 rate limited",
            "메시지 보내기 실패 · 429 요청 한도 초과",
        ),
        level: (("Error", "오류"), TagTone::Danger),
        duration: Some("7.40s"),
        description: ("14:06:19 · Model · Agent", "14:06:19 · 모델 · 에이전트"),
        facts: &[
            (("Model", "모델"), "Gemini 3 Pro"),
            (("Attempts", "시도"), "3/3"),
            (("Trace ID", "추적 ID"), "tr_01JB7R0C5K"),
        ],
    },
    Record {
        id: "log_9e52",
        title: (
            "Retrying after 429 · retry-after 2s",
            "429 후 재시도 · retry-after 2초",
        ),
        level: (("Warning", "경고"), TagTone::Warning),
        duration: None,
        description: ("14:02:31 · Model · Agent", "14:02:31 · 모델 · 에이전트"),
        facts: &[
            (("Policy", "정책"), "3"),
            (("Reason", "이유"), "RESOURCE_EXHAUSTED"),
        ],
    },
    Record {
        id: "log_9d10",
        title: (
            "Schedule ran · Weekly notes",
            "예약 작업 실행 · 주간 회의 정리",
        ),
        level: (("Info", "정보"), TagTone::Neutral),
        duration: Some("12.1s"),
        description: (
            "14:00:00 · Schedule · Agent",
            "14:00:00 · 예약 작업 · 에이전트",
        ),
        facts: &[(("Result", "결과"), "OK")],
    },
];

fn pick(lang: Lang, text: (&'static str, &'static str)) -> &'static str {
    lang.pick(text.0, text.1)
}

/// A level tag with its duration, on one line.
fn level_meta(
    tag: (&'static str, TagTone),
    duration: Option<&'static str>,
    id: String,
) -> AnyElement {
    let mut meta = div().flex().items_center().gap(gpui::px(4.));
    meta = meta.child(
        Tag::new(SharedString::from(id), tag.0)
            .size(TagSize::Sm)
            .tone(tag.1),
    );
    if let Some(duration) = duration {
        meta = meta.child(Typo::caption(duration).tone(Tone::Tertiary).tabular());
    }
    meta.into_any_element()
}

fn log_list(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let open = window.use_keyed_state("dr-log-list", cx, |_, _| Some("log_9e52"));
    let current = *open.read(cx);
    let rows = LOGS.iter().map(|record| {
        let state = open.clone();
        let id = record.id;
        let mut facts = Stack::new()
            .gap(Space::Xs)
            .child(KeyValueRow::new("ID", id).value_size(ValueSize::Caption));
        for (label, value) in record.facts {
            facts = facts
                .child(KeyValueRow::new(pick(lang, *label), *value).value_size(ValueSize::Caption));
        }
        DisclosureRow::new(id, pick(lang, record.title))
            .description(pick(lang, record.description))
            .meta_element(level_meta(
                (pick(lang, record.level.0), record.level.1),
                record.duration,
                format!("{id}-tag"),
            ))
            .open(current == Some(id))
            .on_toggle(move |_, _, cx| {
                state.update(cx, |current, cx| {
                    *current = if *current == Some(id) { None } else { Some(id) };
                    cx.notify();
                });
            })
            .child(facts)
    });
    disclosure_row::list(rows).into_any_element()
}

fn trace_steps(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let open = window.use_keyed_state("dr-trace", cx, |_, _| Some("request"));
    let current = *open.read(cx);
    let t = |en: &'static str, ko: &'static str| lang.pick(en, ko);
    let step = |id: &'static str, title: &'static str| {
        let state = open.clone();
        DisclosureRow::new(id, title)
            .affordance(Affordance::None)
            .open(current == Some(id))
            .on_toggle(move |_, _, cx| {
                state.update(cx, |current, cx| {
                    *current = if *current == Some(id) { None } else { Some(id) };
                    cx.notify();
                });
            })
    };
    let tag_meta = |tone: TagTone, label: &'static str, time: &'static str, id: &'static str| {
        let row = div()
            .flex()
            .items_center()
            .gap(gpui::px(4.))
            .child(Tag::new(id, label).size(TagSize::Sm).tone(tone))
            .child(Typo::caption(time).tone(Tone::Tertiary));
        row.into_any_element()
    };
    let rows = [
        DisclosureRow::new("dr-send", t("Send message", "메시지 보내기"))
            .affordance(Affordance::None)
            .meta("4ms")
            .description("+0.00s"),
        DisclosureRow::new("dr-deliver", t("Deliver", "전달"))
            .affordance(Affordance::None)
            .meta("18ms")
            .description("+0.00s"),
        step("turn", t("Run turn", "턴 실행"))
            .count(8)
            .meta("9.82s")
            .description("+0.02s"),
        step("request", t("Model request 1/3", "모델 요청 1/3"))
            .attention(Attention::Error)
            .count(1)
            .description("+0.17s")
            .meta_element(tag_meta(TagTone::Danger, "429", "412ms", "dr-tag-429"))
            .child(KeyValueRow::new(t("Status", "상태"), "429").value_size(ValueSize::Caption)),
        step("wait", t("Retry wait", "재시도 대기"))
            .attention(Attention::Warning)
            .description("+0.58s")
            .meta_element(tag_meta(
                TagTone::Warning,
                t("Wait", "대기"),
                "2s",
                "dr-tag-wait",
            ))
            .reveals()
            .child(KeyValueRow::new("retry-after", "2s").value_size(ValueSize::Caption)),
    ];
    disclosure_row::list(rows).into_any_element()
}
