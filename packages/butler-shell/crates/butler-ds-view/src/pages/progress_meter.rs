//! ProgressMeter.showcase.tsx: indeterminate, a changing fill, the default, the tones, bare and thin.
use butler_ds::ui::blocks::progress_meter::{MeterTone, ProgressMeter};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Inline, Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Indeterminate",
            render: indeterminate,
        },
        Story {
            name: "Fill change",
            render: fill_change,
        },
        Story {
            name: "Default",
            render: plain,
        },
        Story {
            name: "Tones",
            render: tones,
        },
        Story {
            name: "Bare",
            render: bare,
        },
        Story {
            name: "Thin (page load line)",
            render: thin,
        },
    ]
}

fn indeterminate(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (downloading, received) = lang.pick(
        ("Downloading", "44 MB downloaded"),
        ("다운로드 중", "44MB 받음"),
    );
    ProgressMeter::indeterminate("pm-indeterminate")
        .label(downloading)
        .meta(received)
        .into_any_element()
}

fn fill_change(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let round = window.use_keyed_state("pm-round", cx, |_, _| 0usize);
    let at = *round.read(cx);
    let value = [18., 64., 92., 35.][at % 4];
    let (context, changes, replay) = lang.pick(
        ("Context window", "Changes", "Replay"),
        ("컨텍스트 창", "변경", "다시 재생"),
    );
    let _ = changes;
    Stack::new()
        .gap(Space::Md)
        .child(
            ProgressMeter::new("pm-fill", value)
                .label(context)
                .meta(format!("{value}%")),
        )
        .child(
            ProgressMeter::new("pm-fill-bare", 100. - value)
                .bare()
                .tone(MeterTone::Success),
        )
        .child(
            Inline::new().child(
                Button::new("pm-replay")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(replay)
                    .on_click(move |_, _, cx| {
                        round.update(cx, |round, cx| {
                            *round += 1;
                            cx.notify();
                        });
                    }),
            ),
        )
        .child(probe(format!("pm-fill-{value}")))
        .into_any_element()
}

fn plain(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (context, full) = lang.pick(("Context window", "42% full"), ("컨텍스트 창", "42% 사용"));
    ProgressMeter::new("pm-default", 42.)
        .label(context)
        .meta(full)
        .into_any_element()
}

fn tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (done, blocked, failed) =
        lang.pick(("Done", "Blocked", "Failed"), ("완료", "막힘", "실패"));
    Stack::new()
        .gap(Space::Sm)
        .child(
            ProgressMeter::new("pm-success", 80.)
                .label(done)
                .tone(MeterTone::Success),
        )
        .child(
            ProgressMeter::new("pm-warning", 35.)
                .label(blocked)
                .tone(MeterTone::Warning),
        )
        .child(
            ProgressMeter::new("pm-danger", 12.)
                .label(failed)
                .tone(MeterTone::Danger),
        )
        .into_any_element()
}

fn bare(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let changes = lang.pick("Changes", "변경");
    Stack::new()
        .gap(Space::Sm)
        .children([100., 64., 30., 8.].map(|value| {
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(format!("{changes} {value}")).tabular())
                .child(ProgressMeter::new(format!("pm-bare-{value}"), value).bare())
        }))
        .into_any_element()
}

fn thin(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let loading = lang.pick("Loading page", "페이지 로딩 중");
    Stack::new()
        .gap(Space::Sm)
        .children([72., 30.].map(|value| {
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(format!("{loading} {value}%")).tabular())
                .child(ProgressMeter::new(format!("pm-thin-{value}"), value).thin())
        }))
        .into_any_element()
}
