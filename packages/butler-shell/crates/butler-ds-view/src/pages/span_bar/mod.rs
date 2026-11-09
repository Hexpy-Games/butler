//! SpanBar.showcase.tsx (with SpanBar.showcaseParts.tsx): a Gemini send as a trace, the six
//! tones solid and hatched, segments, edges, a custom axis, text-indent plain rows and
//! row-indent rows.
mod data;
mod trace;

use butler_ds::ui::blocks::span_bar::{SpanAxis, SpanBar, SpanSegment, SpanTone};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use self::data::{TOTAL, children, find, format_ms};
use super::Story;
use crate::copy::Lang;

const TONES: [SpanTone; 6] = [
    SpanTone::Model,
    SpanTone::Tool,
    SpanTone::App,
    SpanTone::Agent,
    SpanTone::Error,
    SpanTone::Wait,
];

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Trace of a Gemini send",
            render: trace::gemini,
        },
        Story {
            name: "Tones: solid and hatch",
            render: tones,
        },
        Story {
            name: "Segments",
            render: segments,
        },
        Story {
            name: "Edges",
            render: edges,
        },
        Story {
            name: "Axis with custom ticks",
            render: custom_axis,
        },
        Story {
            name: "Text indent on plain rows",
            render: trace::plain,
        },
        Story {
            name: "Row indent (chevron after the title)",
            render: trace::row_indent,
        },
    ]
}

/// `Labelled`
fn labelled(caption: &'static str, child: AnyElement) -> AnyElement {
    Stack::new()
        .gap(Space::None)
        .child(Typo::caption(caption).tone(Tone::Secondary))
        .child(child)
        .into_any_element()
}

fn tone_caption(lang: Lang, tone: SpanTone) -> &'static str {
    match tone {
        SpanTone::Model => lang.pick("Model · HTTP request, stream", "모델 · HTTP 요청, 스트림"),
        SpanTone::Tool => lang.pick("Tool · MCP call", "도구 · MCP 호출"),
        SpanTone::App => lang.pick("App side (send, deliver)", "앱 쪽 단계 (보내기, 전달)"),
        SpanTone::Agent => lang.pick(
            "Agent work (turn, pick, context, memory)",
            "에이전트 작업 (턴, 선택, 컨텍스트, 기억)",
        ),
        SpanTone::Error => lang.pick("Error", "오류"),
        SpanTone::Wait => lang.pick("Wait · retry · warning", "대기 · 재시도 · 경고"),
    }
}

fn tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let half = TOTAL / 2.;
    let rows = TONES.iter().enumerate().map(|(index, tone)| {
        let caption = tone_caption(lang, *tone);
        let bars = Stack::new()
            .gap(Space::None)
            .child(
                SpanBar::new(("span-tone", index), 0., TOTAL, TOTAL)
                    .tone(*tone)
                    .label(caption),
            )
            .child(
                SpanBar::new(("span-tone-split", index), 0., TOTAL, TOTAL)
                    .tone(*tone)
                    .segments([
                        SpanSegment {
                            offset: 0.,
                            duration: half,
                            tone: *tone,
                        },
                        SpanSegment {
                            offset: half,
                            duration: half,
                            tone: *tone,
                        },
                    ]),
            );
        labelled(caption, bars.into_any_element())
    });
    Stack::new()
        .gap(Space::Sm)
        .children(rows)
        .into_any_element()
}

/// `StepBar`: a step's bar on the trace axis, split over its direct children.
fn step_bar(caption: &'static str, id: &'static str) -> AnyElement {
    let Some(step) = find(id) else {
        return Stack::new().into_any_element();
    };
    let segments = children(id).map(|child| SpanSegment {
        offset: child.offset,
        duration: child.duration,
        tone: child.tone(),
    });
    let bar = SpanBar::new(
        format!("span-step-bar-{id}"),
        step.offset,
        step.duration,
        TOTAL,
    )
    .tone(step.tone())
    .segments(segments)
    .label(caption);
    labelled(caption, bar.into_any_element())
}

fn segments(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(SpanAxis::new("span-segments-axis", TOTAL).format(move |ms| format_ms(lang, ms)))
        .child(step_bar(
            lang.pick("Run turn: 8 direct steps", "턴 실행: 직접 단계 8개"),
            "turn",
        ))
        .child(step_bar(
            lang.pick(
                "Model request 1/3: one HTTP request",
                "모델 요청 1/3: HTTP 요청 1개",
            ),
            "req-1",
        ))
        .into_any_element()
}

fn edges(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let tiny = lang.pick("4ms of 9.84s (3px minimum)", "9.84초 중 4ms (최소 3px)");
    let clamped = lang.pick("Runs past the trace (clamped)", "추적 끝을 넘음 (잘림)");
    let end = lang.pick("Zero length at the end", "끝에서 길이 0");
    let past = [
        SpanSegment {
            offset: 7400.,
            duration: 1000.,
            tone: SpanTone::Error,
        },
        SpanSegment {
            offset: 9000.,
            duration: 4000.,
            tone: SpanTone::Model,
        },
    ];
    Stack::new()
        .gap(Space::Sm)
        .child(labelled(
            tiny,
            SpanBar::new("span-edge-tiny", 0., 4., TOTAL)
                .tone(SpanTone::App)
                .label(tiny)
                .into_any_element(),
        ))
        .child(labelled(
            clamped,
            SpanBar::new("span-edge-clamped", 7200., 9000., TOTAL)
                .tone(SpanTone::Wait)
                .segments(past)
                .label(clamped)
                .into_any_element(),
        ))
        .child(labelled(
            end,
            SpanBar::new("span-edge-end", TOTAL, 0., TOTAL)
                .tone(SpanTone::Agent)
                .label(end)
                .into_any_element(),
        ))
        .into_any_element()
}

fn custom_axis(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Xs)
        .child(
            SpanAxis::new("span-custom-axis", 1840.)
                .ticks([500., 1000., 1500.])
                .format(move |ms| format_ms(lang, ms)),
        )
        .child(SpanBar::new("span-custom-bar", 120., 1480., 1840.).label(format_ms(lang, 1480.)))
        .into_any_element()
}
