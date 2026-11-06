//! ProgressRing.showcase.tsx.
use butler_ds::tokens::Density;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant, container};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::progress_ring::{ProgressRing, Size, Tone};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, Entity, IntoElement, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    preparing: &'static str,
    downloading: &'static str,
    advance: &'static str,
    indeterminate: &'static str,
    reset: &'static str,
    ready: &'static str,
    failed: &'static str,
    restart: &'static str,
    settings: &'static str,
    tones: [&'static str; 4],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            preparing: "Preparing update",
            downloading: "Downloading update",
            advance: "Advance",
            indeterminate: "Unknown size",
            reset: "Reset",
            ready: "Update ready",
            failed: "Update failed",
            restart: "Restart",
            settings: "Settings",
            tones: ["Default", "Complete", "Low space", "Failed"],
        },
        Copy {
            preparing: "업데이트 준비 중",
            downloading: "업데이트 받는 중",
            advance: "진행",
            indeterminate: "크기 모름",
            reset: "처음으로",
            ready: "업데이트 준비됨",
            failed: "업데이트 실패",
            restart: "다시 시작",
            settings: "설정",
            tones: ["기본", "완료", "공간 부족", "실패"],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Values",
            render: values,
        },
        Story {
            name: "Sizes",
            render: sizes,
        },
        Story {
            name: "Indeterminate",
            render: indeterminate,
        },
        Story {
            name: "Tones",
            render: tones,
        },
        Story {
            name: "Sidebar update row",
            render: sidebar_rows,
        },
        Story {
            name: "Sidebar densities",
            render: sidebar_densities,
        },
        Story {
            name: "Live",
            render: live,
        },
    ]
}

/// A ring over its caption.
fn captioned(ring: ProgressRing, caption: impl Into<gpui::SharedString>) -> AnyElement {
    Stack::new()
        .gap(Space::Xs)
        .cross(Cross::Center)
        .child(ring)
        .child(Typo::caption(caption))
        .into_any_element()
}

fn values(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let mut row = Stack::row().gap(Space::Xl).wrap(true);
    for (index, value) in [0., 0.08, 0.25, 0.5, 0.75, 1.].into_iter().enumerate() {
        let ring = ProgressRing::new(format!("ring-value-{index}"))
            .size(Size::Lg)
            .value(value);
        row = row.child(captioned(ring, format!("{}%", (value * 100.0_f32).round())));
    }
    row.into_any_element()
}

fn sizes(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let mut rows = Stack::new().gap(Space::Lg);
    for spinning in [false, true] {
        let mut row = Stack::row().gap(Space::Xl).cross(Cross::End).wrap(true);
        for (size, name) in [
            (Size::Xs, "xs"),
            (Size::Sm, "sm"),
            (Size::Md, "md"),
            (Size::Lg, "lg"),
            (Size::Sidebar, "sidebar"),
        ] {
            let mut ring = ProgressRing::new(format!("ring-size-{spinning}-{name}"))
                .size(size)
                .value(0.62);
            if spinning {
                ring = ring.indeterminate();
            }
            row = row.child(captioned(ring, name));
        }
        rows = rows.child(row);
    }
    rows.into_any_element()
}

/// Indeterminate is the DS Spinner itself, in the ring's square.
fn indeterminate(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let md =
        f32::from(butler_ds::ui::context::Ds::get(cx).len(butler_ds::tokens::Length::IconSizeMd));
    Stack::new()
        .gap(Space::Md)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(ProgressRing::new("ring-indeterminate").indeterminate())
                .child(Typo::body(c.preparing)),
        )
        .child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(Spinner::new("ring-spinner").size(md))
                .child(Typo::caption("Spinner")),
        )
        .into_any_element()
}

fn tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let mut row = Stack::row().gap(Space::Xl).wrap(true);
    for (index, (tone, value)) in [
        (Tone::Default, 0.6),
        (Tone::Success, 1.),
        (Tone::Warning, 0.86),
        (Tone::Danger, 0.4),
    ]
    .into_iter()
    .enumerate()
    {
        let ring = ProgressRing::new(format!("ring-tone-{index}"))
            .size(Size::Lg)
            .tone(tone)
            .value(value);
        row = row.child(captioned(ring, c.tones[index]));
    }
    row.into_any_element()
}

/// A sidebar ring (aria-hidden: the row names itself).
fn sidebar_ring(id: &'static str) -> ProgressRing {
    ProgressRing::new(id).size(Size::Sidebar)
}

/// The sidebar update row: determinate, indeterminate, complete with an action, failed, settings.
fn sidebar_rows(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let restart = Button::new("ring-restart")
        .size(ButtonSize::Xs)
        .variant(Variant::Outline)
        .text(c.restart);
    Stack::new()
        .gap(Space::Xs)
        .child(
            NavRow::new("nav-downloading", c.downloading)
                .icon(sidebar_ring("nav-ring-value").value(0.42))
                .badge("42%")
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("nav-preparing", c.preparing)
                .icon(sidebar_ring("nav-ring-indeterminate").indeterminate())
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("nav-ready", c.ready)
                .icon(sidebar_ring("nav-ring-done").value(1.).tone(Tone::Success))
                .actions(restart)
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("nav-failed", c.failed)
                .glyph(Icon::CircleAlert)
                .on_click(|_, _, _| {}),
        )
        .child(
            NavRow::new("nav-settings", c.settings)
                .glyph(Icon::Settings)
                .on_click(|_, _, _| {}),
        )
        .into_any_element()
}

/// The same row at each sidebar density.
fn sidebar_densities(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let mut rows = Stack::new().gap(Space::Xs);
    for (density, name) in [
        (Density::Compact, "compact"),
        (Density::Comfortable, "comfortable"),
        (Density::Touch, "touch"),
    ] {
        rows = rows.child(
            NavRow::new(
                format!("nav-density-{name}"),
                format!("{} · {name}", c.downloading),
            )
            .icon(sidebar_ring(name).value(0.42).density(density))
            .badge("42%")
            .density(density)
            .on_click(|_, _, _| {}),
        );
    }
    rows.into_any_element()
}

/// A row stepping through determinate and indeterminate progress: the box never moves.
fn live(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let value = window.use_keyed_state("ring-live-value", cx, |_, _| 0.3_f32);
    let spinning = window.use_keyed_state("ring-live-indeterminate", cx, |_, _| false);
    let (v, unknown) = (*value.read(cx), *spinning.read(cx));
    let percent = (v * 100.0).round();
    let mut ring = ProgressRing::new("ring-live").size(Size::Lg).value(v);
    if unknown {
        ring = ring.indeterminate();
    }
    if v >= 1. {
        ring = ring.tone(Tone::Success);
    }
    Stack::new()
        .gap(Space::Md)
        .child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(ring)
                .child(Typo::body(if unknown {
                    c.preparing.to_owned()
                } else {
                    format!("{} · {percent}%", c.downloading)
                }))
                .child(probe(format!(
                    "live-{}",
                    if unknown {
                        "unknown".to_owned()
                    } else {
                        format!("{percent}")
                    }
                ))),
        )
        .child(live_buttons(&c, value, spinning))
        .into_any_element()
}

/// Advance, Unknown size and Reset: each steps the live ring's state.
fn live_buttons(c: &Copy, value: Entity<f32>, spinning: Entity<bool>) -> impl IntoElement {
    let (advance, toggle, reset) = (
        (value.clone(), spinning.clone()),
        spinning.clone(),
        (value, spinning),
    );
    container(ButtonSize::Sm)
        .child(
            Button::new("ring-advance")
                .size(ButtonSize::Sm)
                .variant(Variant::Outline)
                .text(c.advance)
                .on_click(move |_, _, cx| {
                    advance.1.update(cx, |s, _| *s = false);
                    advance.0.update(cx, |v, cx| {
                        *v = (*v + 0.2).min(1.);
                        cx.notify();
                    });
                }),
        )
        .child(
            Button::new("ring-unknown")
                .size(ButtonSize::Sm)
                .variant(Variant::Outline)
                .text(c.indeterminate)
                .on_click(move |_, _, cx| {
                    toggle.update(cx, |s, cx| {
                        *s = !*s;
                        cx.notify();
                    });
                }),
        )
        .child(
            Button::new("ring-reset")
                .size(ButtonSize::Sm)
                .variant(Variant::Borderless)
                .text(c.reset)
                .on_click(move |_, _, cx| {
                    reset.1.update(cx, |s, _| *s = false);
                    reset.0.update(cx, |v, cx| {
                        *v = 0.;
                        cx.notify();
                    });
                }),
        )
}
