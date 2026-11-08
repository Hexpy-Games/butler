//! WorkerActivityRow.showcase.tsx: a worker that completes (the success pulse), and a running one
//! with a stop action.
use butler_ds::ui::motion;
use std::time::Duration;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::worker_activity::WorkerActivityRow;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

/// The replay's delay before the worker completes. // DS: WorkerActivityRow.showcase.tsx:35
const COMPLETES_AFTER: Duration = Duration::from_millis(600);

struct Copy {
    title: &'static str,
    running: &'static str,
    done: &'static str,
    replay: &'static str,
    stop: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "Implementation worker",
            running: "Running validation",
            done: "Finished",
            replay: "Replay",
            stop: "Stop",
        },
        Copy {
            title: "구현 워커",
            running: "검증 실행 중",
            done: "완료",
            replay: "다시 재생",
            stop: "중지",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Completes",
            render: completes,
        },
        Story {
            name: "Running with action",
            render: |lang, _, cx| {
                let c = copy(lang);
                let ds = Ds::get(cx);
                WorkerActivityRow::new("worker-running-story", c.title)
                    .icon(icon(Icon::Activity, IconSize::Md, ds))
                    .description(c.running)
                    .phase("executing")
                    .actions(
                        Button::new("worker-stop")
                            .size(Size::Xs)
                            .variant(Variant::Borderless)
                            .text(c.stop),
                    )
                    .into_any_element()
            },
        },
    ]
}

fn completes(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let replayed =
        window.use_keyed_state("worker-replay-at", cx, |_, _| None::<std::time::Instant>);
    let now = cx.background_executor().now();
    let done = replayed
        .read(cx)
        .is_some_and(|at| now.saturating_duration_since(at) >= COMPLETES_AFTER);
    if let Some(at) = *replayed.read(cx)
        && !done
    {
        motion::wake_after(
            window,
            cx,
            COMPLETES_AFTER.saturating_sub(now.saturating_duration_since(at)),
        );
    }
    let ds = Ds::get(cx);
    let glyph = if done {
        Icon::CheckCircle2
    } else {
        Icon::Activity
    };
    let row = WorkerActivityRow::new("worker-complete-story", c.title)
        .icon(icon(glyph, IconSize::Md, ds))
        .description(if done { c.done } else { c.running })
        .phase(if done { "complete" } else { "verifying" });
    let replay = Button::new("worker-replay")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(c.replay)
        .on_click(move |_, _, cx| {
            replayed.update(cx, |at, cx| {
                *at = Some(cx.background_executor().now());
                cx.notify();
            });
        });
    Stack::new()
        .gap(Space::Md)
        .child(super::probe(format!("worker-complete-{done}")))
        .child(row)
        .child(replay)
        .into_any_element()
}
