//! SuccessCheck.showcase.tsx.
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::success_check::SuccessCheck;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

/// `ICON_SIZE` sm, md, lg and xl.
const SIZES: [f32; 4] = [14., 16., 20., 24.];

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Draw",
            render: draw,
        },
        Story {
            name: "Static",
            render: still,
        },
    ]
}

fn draw(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let run = window.use_keyed_state("success-check-run", cx, |_, _| 0usize);
    let key = *run.read(cx);
    let (replay, plain, ring_label) = lang.pick(
        ("Replay", "Plain (CopyButton)", "Ring (LoadingIndicator)"),
        ("다시 재생", "기본 (CopyButton)", "링 (LoadingIndicator)"),
    );
    let group = |title: &'static str, ring: bool| {
        Stack::new()
            .gap(Space::Sm)
            .cross(Cross::Center)
            .child(SIZES.iter().fold(
                Stack::row().gap(Space::Md).cross(Cross::Center),
                |row, size| {
                    let check = SuccessCheck::new(gpui::SharedString::from(format!(
                        "check-{title}-{size}-{key}"
                    )))
                    .size(*size);
                    row.child(if ring { check.ring() } else { check })
                },
            ))
            .child(Typo::caption(title))
    };
    Stack::new()
        .gap(Space::Md)
        .child(
            Stack::row()
                .gap(Space::Xl)
                .cross(Cross::Center)
                .wrap(true)
                .child(group(plain, false))
                .child(group(ring_label, true)),
        )
        .child(
            Stack::row().child(
                Button::new("success-check-replay")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(replay)
                    .on_click(move |_, _, cx| {
                        run.update(cx, |n, cx| {
                            *n += 1;
                            cx.notify();
                        });
                    }),
            ),
        )
        .into_any_element()
}

fn still(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let text = lang.pick("Static (mounted done)", "정적 (완료 상태로 표시)");
    Stack::row()
        .gap(Space::Md)
        .cross(Cross::Center)
        .child(SuccessCheck::new("check-still").size(20.).still())
        .child(
            SuccessCheck::new("check-still-ring")
                .size(20.)
                .ring()
                .still(),
        )
        .child(Typo::caption(text))
        .into_any_element()
}
