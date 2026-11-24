//! EventTimeline.showcase.tsx: the project history (a day's section, a row per event, the linked
//! session one step in) and a single event.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::event_timeline::{EventTimeline, EventTimelineItem, Lead};
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Tone, Typo, Weight, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, div};

use super::Story;
use crate::copy::Lang;

struct Event {
    title: &'static str,
    meta: &'static str,
    session: Option<&'static str>,
}

struct Copy {
    date: &'static str,
    events: [Event; 3],
    answer: [(&'static str, &'static str, &'static str); 2],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            date: "September 25, 2026",
            events: [
                Event {
                    title: "Design system final cleanup: every lint baseline at zero",
                    meta: "9:15 AM · Completion recorded · 2 published artifacts",
                    session: Some("Final cleanup session with a long title that truncates"),
                },
                Event {
                    title: "Spec: Butler Dedicated Client Design System",
                    meta: "8:15 AM · Updated",
                    session: None,
                },
                Event {
                    title: "Plan: move the timeline styling into the DS",
                    meta: "7:15 AM · Created",
                    session: Some("Planning"),
                },
            ],
            answer: [
                (
                    "Sep 27, 2026",
                    "CDN launcher files altered",
                    "Analysis says four launcher scripts gained a call to an outside script.",
                ),
                (
                    "Oct 24, 2026",
                    "Earliest malicious run",
                    "Anyone who ran the launcher after this date is in scope.",
                ),
            ],
        },
        Copy {
            date: "2026년 9월 25일",
            events: [
                Event {
                    title: "디자인 시스템 최종 정리: 모든 린트 기준선을 0으로",
                    meta: "오전 9:15 · 완료 기록 · 산출물 2개",
                    session: Some("제목이 길어서 버튼 안에서 말줄임되는 최종 정리 세션"),
                },
                Event {
                    title: "Spec: 버틀러 전용 클라이언트 디자인 시스템",
                    meta: "오전 8:15 · 갱신",
                    session: None,
                },
                Event {
                    title: "Plan: 타임라인 스타일을 DS로 옮기기",
                    meta: "오전 7:15 · 생성",
                    session: Some("계획"),
                },
            ],
            answer: [
                (
                    "2026-09-27",
                    "CDN 배포 파일 변조",
                    "런처 자바스크립트 4개에 외부 스크립트 호출 코드가 삽입됐다는 분석.",
                ),
                (
                    "2026-10-24",
                    "가장 이른 악성코드 실행",
                    "이날 이후 런처를 실행한 이용자가 위험 범위로 지목.",
                ),
            ],
        },
    )
}

const MARKERS: [Icon; 3] = [Icon::CheckCircle2, Icon::FileText, Icon::MessageSquare];

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Project history",
            render: |lang, _, cx| history(lang, cx),
        },
        Story {
            name: "Answer timeline",
            render: |lang, _, cx| answer(lang, cx),
        },
        Story {
            name: "Single event",
            render: |lang, _, cx| single(lang, cx),
        },
    ]
}

fn history(lang: Lang, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let mut timeline = EventTimeline::new();
    for (index, event) in c.events.iter().enumerate() {
        let mut stack = Stack::new().gap(Space::Xs).child(
            NavRow::new(format!("event-{index}"), event.title)
                .label_element(Typo::text(event.title).line_clamp(2).wrap(Wrap::Anywhere))
                .multiline()
                .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
                .meta(Typo::caption(event.meta).tone(Tone::Secondary))
                .on_click(|_, _, _| {}),
        );
        if let Some(session) = event.session {
            stack = stack.child(
                div().pl(ds.len(butler_ds::tokens::Length::SpaceSm)).child(
                    Button::new(format!("session-{index}"))
                        .variant(Variant::Borderless)
                        .size(Size::Xs)
                        .icon_start(icon(Icon::MessageSquare, IconSize::Md, ds))
                        .icon_end(icon(Icon::ChevronRight, IconSize::Md, ds))
                        .text(session)
                        .on_click(|_, _, _| {}),
                ),
            );
        }
        timeline = timeline.item(EventTimelineItem::new(
            icon(MARKERS[index], IconSize::Md, ds),
            stack,
        ));
    }
    Section::new("event-history")
        .title(c.date)
        .child(timeline)
        .into_any_element()
}

fn answer(lang: Lang, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let mut timeline = EventTimeline::new().lead(Lead::Caption);
    for (when, title, text) in c.answer {
        timeline = timeline.item(EventTimelineItem::new(
            icon(Icon::Circle, IconSize::Sm, ds),
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(when).tone(Tone::Tertiary))
                .child(Typo::label(title).weight(Weight::Semibold))
                .child(Typo::body(text)),
        ));
    }
    timeline.into_any_element()
}

fn single(lang: Lang, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    EventTimeline::new()
        .item(EventTimelineItem::new(
            icon(Icon::FileText, IconSize::Md, ds),
            NavRow::new("event-single", c.events[1].title)
                .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
                .on_click(|_, _, _| {}),
        ))
        .into_any_element()
}
