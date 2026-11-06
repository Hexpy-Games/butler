//! RollingSwap.showcase.tsx. The live ticker advances every 1600 ms on the frame clock.
use std::time::Duration;

use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::rolling_swap::RollingSwap;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

/// The ticker's interval. // DS: RollingSwap.showcase.tsx:25
const TICK: Duration = Duration::from_millis(1600);

fn steps(lang: Lang) -> [&'static str; 4] {
    lang.pick(
        [
            "Reading the project notes",
            "Searching for the failing test",
            "Running the unit tests",
            "Summarizing what changed",
        ],
        [
            "프로젝트 메모를 읽는 중",
            "실패한 테스트를 찾는 중",
            "단위 테스트를 실행하는 중",
            "바뀐 점을 요약하는 중",
        ],
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Live status",
            render: |lang, window, cx| ticker(lang, true, window, cx),
        },
        Story {
            name: "Step by step",
            render: |lang, window, cx| ticker(lang, false, window, cx),
        },
    ]
}

fn ticker(lang: Lang, auto: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let list = steps(lang);
    let id = if auto { "rolling-live" } else { "rolling-step" };
    let started = window.use_keyed_state(format!("{id}-start"), cx, |_, cx| {
        cx.background_executor().now()
    });
    let step = window.use_keyed_state(format!("{id}-step"), cx, |_, _| 0usize);
    let index = if auto {
        window.request_animation_frame();
        let elapsed = cx
            .background_executor()
            .now()
            .saturating_duration_since(*started.read(cx));
        (elapsed.as_millis() / TICK.as_millis()) as usize % list.len()
    } else {
        *step.read(cx)
    };
    let text = list[index];
    let swap = RollingSwap::new(id, index.to_string(), move |_, _| {
        Typo::body(text).into_any_element()
    });
    let mut column = Stack::new().gap(Space::Md).child(swap);
    if !auto {
        column = column.child(
            Button::new("rolling-next")
                .variant(Variant::Outline)
                .size(Size::Sm)
                .text(lang.pick("Next step", "다음 단계"))
                .on_click(move |_, _, cx| {
                    step.update(cx, |step, cx| {
                        *step = (*step + 1) % 4;
                        cx.notify();
                    });
                }),
        );
    }
    column.into_any_element()
}
