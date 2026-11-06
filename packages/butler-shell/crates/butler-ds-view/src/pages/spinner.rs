//! Spinner.showcase.tsx. ButtonContainer is `button::container`; LoadingIndicator is a stand-in
//! (`standins.rs`).
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant, container};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::loading_indicator;

struct Copy {
    syncing: &'static str,
    synced: &'static str,
    complete: &'static str,
    again: &'static str,
    replay: &'static str,
    session: &'static str,
    running: &'static str,
    failed: &'static str,
    idle: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            syncing: "Syncing",
            synced: "Synced",
            complete: "Complete loading",
            again: "Load again",
            replay: "Replay",
            session: "Token page review",
            running: "Running",
            failed: "Failed",
            idle: "Waiting",
        },
        Copy {
            syncing: "동기화 중",
            synced: "동기화됨",
            complete: "불러오기 완료",
            again: "다시 불러오기",
            replay: "다시 재생",
            session: "토큰 페이지 검토",
            running: "진행 중",
            failed: "실패",
            idle: "대기 중",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sizes and busy button",
            render: busy_button,
        },
        Story {
            name: "Status icon slot",
            render: status_slot,
        },
        Story {
            name: "Running session button",
            render: session,
        },
        Story {
            name: "Labelled (status role)",
            render: |_, _, _| {
                Spinner::new("spinner-labelled")
                    .size(18.)
                    .into_any_element()
            },
        },
    ]
}

fn busy_button(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let busy = window.use_keyed_state("spinner-busy", cx, |_, _| true);
    let run = window.use_keyed_state("spinner-run", cx, |_, _| 0usize);
    let (is_busy, run_n) = (*busy.read(cx), *run.read(cx));
    let ds = Ds::get(cx);
    let mut sizes = Stack::row().cross(Cross::Center).gap(Space::Lg).wrap(true);
    for (token, length) in [
        ("sm", Length::IconSizeSm),
        ("md", Length::IconSizeMd),
        ("lg", Length::IconSizeLg),
        ("xl", Length::IconSizeXl),
        ("2xl", Length::IconSize2xl),
    ] {
        let px = f32::from(ds.len(length));
        sizes = sizes.child(
            Stack::new()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(Spinner::new(format!("spinner-size-{token}-{run_n}")).size(px))
                .child(Typo::caption(format!("icon-{token} · {px}px"))),
        );
    }
    let toggle = busy.clone();
    let replay = run.clone();
    let mut working = Button::new("spinner-working")
        .size(Size::Sm)
        .child(loading_indicator(
            "spinner-working-icon",
            is_busy,
            f32::from(ds.len(Length::IconSizeSm)),
        ))
        .child(if is_busy { c.syncing } else { c.synced });
    if is_busy {
        working = working.disabled();
    }
    Stack::new()
        .gap(Space::Md)
        .child(sizes)
        .child(
            container(Size::Sm)
                .child(working)
                .child(
                    Button::new("spinner-toggle")
                        .size(Size::Sm)
                        .variant(Variant::Outline)
                        .text(if is_busy { c.complete } else { c.again })
                        .on_click(move |_, _, cx| {
                            toggle.update(cx, |busy, cx| {
                                *busy = !*busy;
                                cx.notify();
                            });
                        }),
                )
                .child(
                    Button::new("spinner-replay")
                        .size(Size::Sm)
                        .variant(Variant::Borderless)
                        .text(c.replay)
                        .on_click(move |_, _, cx| {
                            replay.update(cx, |run, cx| {
                                *run += 1;
                                cx.notify();
                            });
                        }),
                ),
        )
        .into_any_element()
}

/// SummaryPanel / SpaceActivity: the spinner replaces the status icon while running.
fn status_slot(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let lg = f32::from(ds.len(Length::IconSizeLg));
    let row = |glyph: AnyElement, text: &'static str| {
        Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(glyph)
            .child(Typo::body(text))
    };
    Stack::new()
        .gap(Space::Sm)
        .child(row(
            Spinner::new("spinner-status").size(lg).into_any_element(),
            c.running,
        ))
        .child(row(
            icon(Icon::CircleAlert, IconSize::Lg, ds).into_any_element(),
            c.failed,
        ))
        .child(row(
            icon(Icon::Circle, IconSize::Lg, ds).into_any_element(),
            c.idle,
        ))
        .into_any_element()
}

fn session(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    Stack::row()
        .gap(Space::Sm)
        .child(
            Button::new("spinner-session-running")
                .variant(Variant::Borderless)
                .size(Size::Xs)
                .child(Spinner::new("spinner-session"))
                .child(Typo::text(c.session).truncate()),
        )
        .child(
            Button::new("spinner-session-idle")
                .variant(Variant::Borderless)
                .size(Size::Xs)
                .child(icon(Icon::MessageSquare, IconSize::Md, ds))
                .child(Typo::text(c.session).truncate()),
        )
        .into_any_element()
}
