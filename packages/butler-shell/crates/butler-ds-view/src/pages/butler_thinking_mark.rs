//! ButlerThinkingMark.showcase.tsx. LoadingIndicator is a stand-in (`standins.rs`).
use butler_ds::ui::motion;
use std::time::Duration;

use butler_ds::ui::button::{Button, Size, Variant, container};
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::thinking_mark::{ButlerThinkingMark, MarkState};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::copy::Lang;
use crate::standins::loading_indicator;

/// Round trip demo: hold the thinking form before settling back. // DS: ButlerThinkingMark.showcase.tsx:21
const ROUND_TRIP_HOLD: Duration = Duration::from_millis(3200);

struct Copy {
    start: &'static str,
    finish: &'static str,
    replay: &'static str,
    round_trip: &'static str,
    idle: &'static str,
    working: &'static str,
    reduced: &'static str,
    fill: &'static str,
    thinking: &'static str,
    worked: &'static str,
    task: &'static str,
    running: &'static str,
    complete: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            start: "Start working",
            finish: "Finish",
            replay: "Replay",
            round_trip: "Replay idle → thinking → idle",
            idle: "Idle (the logo)",
            working: "Working",
            reduced: "Reduced motion: the logo breathes in opacity",
            fill: "Fill (no size)",
            thinking: "Thinking",
            worked: "Worked for 12s",
            task: "Build the token pages",
            running: "Running",
            complete: "Complete",
        },
        Copy {
            start: "작업 시작",
            finish: "완료",
            replay: "다시 재생",
            round_trip: "대기 → 생각 → 대기 다시 재생",
            idle: "대기 (로고)",
            working: "작업 중",
            reduced: "모션 줄이기: 로고가 불투명도로 숨 쉼",
            fill: "채우기 (size 없음)",
            thinking: "생각 중",
            worked: "12초 동안 작업함",
            task: "토큰 페이지 빌드",
            running: "진행 중",
            complete: "완료",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Idle to working",
            render: idle_to_working,
        },
        Story {
            name: "Sizes",
            render: sizes,
        },
        Story {
            name: "Reduced motion",
            render: reduced,
        },
        Story {
            name: "Status to done",
            render: status_to_done,
        },
    ]
}

const SIZES: [(IconSize, &str); 6] = [
    (IconSize::Sm, "sm"),
    (IconSize::Md, "md"),
    (IconSize::Lg, "lg"),
    (IconSize::Xl, "xl"),
    (IconSize::Xxl, "2xl"),
    (IconSize::Xxxl, "3xl"),
];

/// One mark per size, each with its name under it.
fn row(key: &str, state: MarkState, reduced: Option<bool>) -> AnyElement {
    Stack::row()
        .gap(Space::Lg)
        .cross(Cross::End)
        .wrap(true)
        .children(SIZES.map(|(size, name)| {
            let mut mark = ButlerThinkingMark::new(format!("mark-{key}-{name}"))
                .state(state)
                .size(size);
            if let Some(reduced) = reduced {
                mark = mark.reduced_motion(reduced);
            }
            Stack::new()
                .gap(Space::Xs)
                .cross(Cross::Center)
                .child(mark)
                .child(Typo::caption(name).tone(Tone::Tertiary))
        }))
        .into_any_element()
}

/// One continuous morph each way: the logo straight into the halftone moon, and back.
fn idle_to_working(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let working = window.use_keyed_state("mark-working", cx, |_, _| false);
    let run = window.use_keyed_state("mark-run", cx, |_, _| 0usize);
    let trip = window.use_keyed_state("mark-trip", cx, |_, _| None::<std::time::Instant>);
    let now = cx.background_executor().now();
    let held = trip
        .read(cx)
        .is_some_and(|since| now.saturating_duration_since(since) < ROUND_TRIP_HOLD);
    if let Some(since) = *trip.read(cx)
        && held
    {
        motion::wake_after(
            window,
            cx,
            ROUND_TRIP_HOLD.saturating_sub(now.saturating_duration_since(since)),
        );
    }
    let on = *working.read(cx) || held;
    let state = if on {
        MarkState::Working
    } else {
        MarkState::Idle
    };
    let toggle = working.clone();
    let replay_working = working.clone();
    let (replay_run, round_trip) = (run.clone(), trip.clone());
    let key = format!("idle-{}", *run.read(cx));
    Stack::new()
        .gap(Space::Md)
        .child(row(&key, state, None))
        .child(
            container(Size::Sm)
                .child(
                    Button::new("mark-toggle")
                        .variant(Variant::Outline)
                        .size(Size::Sm)
                        .text(if on { c.finish } else { c.start })
                        .on_click(move |_, _, cx| {
                            toggle.update(cx, |on, cx| {
                                *on = !*on;
                                cx.notify();
                            });
                        }),
                )
                .child(
                    Button::new("mark-round-trip")
                        .variant(Variant::Borderless)
                        .size(Size::Sm)
                        .text(c.round_trip)
                        .on_click(move |_, _, cx| {
                            let now = cx.background_executor().now();
                            round_trip.update(cx, |since, cx| {
                                *since = Some(now);
                                cx.notify();
                            });
                        }),
                )
                .child(
                    Button::new("mark-replay")
                        .variant(Variant::Borderless)
                        .size(Size::Sm)
                        .text(c.replay)
                        .on_click(move |_, _, cx| {
                            replay_working.update(cx, |on, cx| {
                                *on = true;
                                cx.notify();
                            });
                            replay_run.update(cx, |run, cx| {
                                *run += 1;
                                cx.notify();
                            });
                        }),
                ),
        )
        .into_any_element()
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Lg)
        .child(Typo::caption(c.idle))
        .child(row("sizes-idle", MarkState::Idle, None))
        .child(Typo::caption(c.working))
        .child(row("sizes-working", MarkState::Working, None))
        .child(Typo::caption(c.fill))
        // DS: ButlerThinkingMark.showcase.tsx:100 (`UNSAFE_style={{ width: 96 }}`)
        .child(
            div()
                .w(px(96.))
                .child(ButlerThinkingMark::new("mark-fill").state(MarkState::Working)),
        )
        .into_any_element()
}

fn reduced(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(Typo::caption(c.reduced))
        .child(row("reduced", MarkState::Working, Some(true)))
        .into_any_element()
}

/// Assistant status: the mark stays mounted; done settles it back to the logo (no check).
fn status_to_done(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let working = window.use_keyed_state("mark-status", cx, |_, _| true);
    let on = *working.read(cx);
    let state = if on {
        MarkState::Working
    } else {
        MarkState::Idle
    };
    let task = format!("{} · {}", c.task, if on { c.running } else { c.complete });
    Stack::new()
        .gap(Space::Md)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(
                    ButlerThinkingMark::new("mark-status-mark")
                        .state(state)
                        .size(IconSize::Lg),
                )
                .child(Typo::body(if on { c.thinking } else { c.worked })),
        )
        .child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(loading_indicator("mark-status-loading", on, 20.))
                .child(Typo::body(task)),
        )
        .child(
            container(Size::Sm).child(
                Button::new("mark-status-toggle")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(if on { c.finish } else { c.start })
                    .on_click(move |_, _, cx| {
                        working.update(cx, |on, cx| {
                            *on = !*on;
                            cx.notify();
                        });
                    }),
            ),
        )
        .into_any_element()
}
