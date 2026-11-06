//! WorkActivityBlock.showcase.tsx: a running and a done activity with their toolchains, the folded
//! timeline (disclosure) of running and done work, the live dot, and a delegation.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::work_activity::{ToolItem, WorkActivityBlock, WorkActivityDisclosure};
use butler_ds::ui::button::{Button, Shape, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    search_title: &'static str,
    search: &'static str,
    search_details: &'static str,
    command_details: &'static str,
    review: &'static str,
    review_title: &'static str,
    running_title: &'static str,
    running_description: &'static str,
    done_title: &'static str,
    done_description: &'static str,
    delegate_title: &'static str,
    work: &'static str,
    worker_call: &'static str,
    worker_details: &'static str,
    worker: &'static str,
    working: &'static str,
    done: &'static str,
    steps: [&'static str; 5],
    latest_running: &'static str,
    latest_done: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            search_title: "Search: gemma connection settings",
            search: "Search",
            search_details: "Reads environment variables and config files to find connection candidates.",
            command_details: "Command output is shown only as a safe summary.",
            review: "Review",
            review_title: "Apply the verified result to the final answer",
            running_title: "Checking the current state with local commands",
            running_description: "Collect verifiable evidence first, then report the result.",
            done_title: "Applying the checked result to the answer",
            done_description: "After it finishes it keeps the same timeline shape instead of becoming a background block.",
            delegate_title: "Delegated research",
            work: "Work",
            worker_call: "Worker call",
            worker_details: "The task was handed over.",
            worker: "Juno · 2/3 · editing files",
            working: "Working",
            done: "Done",
            steps: [
                "Recall the conversation",
                "Confirm the request",
                "Check prices and stock",
                "Compare performance",
                "Review the result",
            ],
            latest_running: "Compare performance · Web search",
            latest_done: "Review the result · Done",
        },
        Copy {
            search_title: "검색: gemma 연결 정보",
            search: "검색",
            search_details: "환경 변수와 설정 파일을 읽어 연결 후보를 찾습니다.",
            command_details: "명령 결과는 안전한 요약으로만 표시합니다.",
            review: "검토",
            review_title: "검증된 결과를 최종 응답에 반영",
            running_title: "로컬 명령으로 현재 상태를 확인합니다",
            running_description: "확인 가능한 근거를 먼저 확보하고 결과를 다음 보고에 반영합니다.",
            done_title: "확인한 결과를 답변에 반영합니다",
            done_description: "완료된 뒤에도 배경 블록으로 바뀌지 않고 같은 타임라인 형태를 유지합니다.",
            delegate_title: "조사 작업 위임",
            work: "작업",
            worker_call: "워커 호출",
            worker_details: "작업을 전달했습니다.",
            worker: "Juno · 2/3 · 파일 수정 중",
            working: "작업 중",
            done: "완료됨",
            steps: [
                "대화 기억 찾기",
                "요청 의도 확인",
                "가격·재고 확인",
                "성능 비교",
                "결과 검토",
            ],
            latest_running: "성능 비교 · 웹 검색",
            latest_done: "결과 검토 · 완료",
        },
    )
}

fn tools(c: &Copy, prefix: &str) -> Vec<ToolItem> {
    vec![
        ToolItem::new(format!("{prefix}-search"), c.search_title, c.search)
            .icon(Icon::Search)
            .details(c.search_details),
        ToolItem::new(
            format!("{prefix}-command"),
            "Bash: env | grep -Ei \"CODEX|GEMMA\"",
            "Bash",
        )
        .icon(Icon::Terminal)
        .details(c.command_details),
        ToolItem::new(format!("{prefix}-tool"), c.review_title, c.review).icon(Icon::Wrench),
    ]
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Running and done",
            render: |lang, _, _| running_and_done(lang),
        },
        Story {
            name: "Folded timeline (disclosure)",
            render: folded,
        },
        Story {
            name: "Live dot",
            render: |lang, _, _| live_dot(lang),
        },
        Story {
            name: "Delegation",
            render: |lang, _, _| delegation(lang),
        },
    ]
}

fn running_and_done(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Lg)
        .child(
            WorkActivityBlock::new("wa-running", c.running_title)
                .description(c.running_description)
                .connected()
                .tools(tools(&c, "wa-running")),
        )
        .child(
            WorkActivityBlock::new("wa-done", c.done_title)
                .description(c.done_description)
                .tools(tools(&c, "wa-done").into_iter().take(2).collect()),
        )
        .into_any_element()
}

/// A folded work timeline: running work has four records so far, done work five.
fn disclosure(
    id: &'static str,
    live: bool,
    c: &Copy,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let expanded = window.use_keyed_state(format!("{id}-expanded"), cx, |_, _| false);
    let open = *expanded.read(cx);
    let count = if live { 4 } else { 5 };
    let steps = &c.steps[..count];
    let status = if live { c.working } else { c.done };
    let latest = if live {
        c.latest_running
    } else {
        c.latest_done
    };
    let timeline = Stack::new()
        .gap(Space::Sm)
        .children(steps.iter().enumerate().map(|(index, step)| {
            let mut block = WorkActivityBlock::new(format!("{id}-{index}"), *step).compact();
            if index + 1 < steps.len() {
                block = block.connected();
            }
            if live && index + 1 == steps.len() {
                block = block.live();
            }
            block
        }));
    let mut disclosure = WorkActivityDisclosure::new(id, status, latest)
        .hidden_count(count - 1)
        .expanded(open)
        .on_toggle(move |_, cx| {
            expanded.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
        })
        .child(
            ScrollArea::new(format!("{id}-scroll"))
                .max_height(MaxHeight::Sm)
                .child(timeline),
        );
    if let Some(previous) = steps.get(count - 2) {
        disclosure = disclosure.previous(SharedString::from(*previous));
    }
    if live {
        disclosure = disclosure.live();
    }
    Stack::new()
        .gap(Space::None)
        .child(super::probe(format!("{id}-expanded-{open}")))
        .child(disclosure)
        .into_any_element()
}

fn folded(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let running = disclosure("wa-disclosure-running", true, &c, window, cx);
    let done = disclosure("wa-disclosure-done", false, &c, window, cx);
    Stack::new()
        .gap(Space::Lg)
        .child(running)
        .child(done)
        .into_any_element()
}

fn live_dot(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .children(c.steps.iter().take(3).enumerate().map(|(index, step)| {
            let mut block = WorkActivityBlock::new(format!("wa-live-{index}"), *step).compact();
            if index < 2 {
                block = block.connected();
            }
            if index == 2 {
                block = block.live();
            }
            block
        }))
        .into_any_element()
}

fn delegation(lang: Lang) -> AnyElement {
    let c = copy(lang);
    WorkActivityBlock::new("wa-delegate", c.delegate_title)
        .tools(vec![
            ToolItem::new("wa-assignment", c.worker_call, c.work)
                .details(c.worker_details)
                .after(
                    Button::new("wa-worker")
                        .variant(Variant::Outline)
                        .shape(Shape::Pill)
                        .text(c.worker),
                ),
        ])
        .into_any_element()
}
