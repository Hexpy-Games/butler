//! UsageBars.showcase.tsx (+ showcaseParts, showcaseSplit): stacked usage columns: the popover
//! strip and the panel chart with y ticks, hover and arrow-key selection with the caller's
//! readout, the hatched subtask parts with a linked legend, single bucket, loading, empty and the
//! live-update demos. The window's wall-clock time stands in for the local clock.
mod data;

use super::sub;

use butler_ds::tokens::Color;
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, SwatchPattern, ValueSize};
use butler_ds::ui::blocks::usage_bars::{Bucket, Emphasis, SLOT_MS, Size, Slot, State, UsageBars};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::Story;
use crate::copy::Lang;
use data::{Chart, compact_tokens, copy};

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Popover",
            render: |l, w, c| popover(l, "ub-popover", None, false, w, c),
        },
        Story {
            name: "Panel with y ticks",
            render: |l, w, c| panel(l, "ub-panel-week", 168, None, w, c),
        },
        Story {
            name: "Gapless all chats",
            render: |l, w, c| panel(l, "ub-panel-day", 24, None, w, c),
        },
        Story {
            name: "Split popover",
            render: |l, w, c| popover(l, "ub-split-popover", None, true, w, c),
        },
        Story {
            name: "Split panel",
            render: |l, w, c| split_panel(l, "ub-split-panel", None, w, c),
        },
        Story {
            name: "Split selected",
            render: split_selected,
        },
        Story {
            name: "Split live update",
            render: |l, w, c| motion(l, "ub-split-motion", true, w, c),
        },
        Story {
            name: "Panel, many buckets",
            render: |l, w, c| panel(l, "ub-panel-month", 720, None, w, c),
        },
        Story {
            name: "Selected",
            render: selected,
        },
        Story {
            name: "Single bucket",
            render: single,
        },
        Story {
            name: "Loading",
            render: loading,
        },
        Story {
            name: "Empty",
            render: empty,
        },
        Story {
            name: "Live update",
            render: |l, w, c| motion(l, "ub-motion", false, w, c),
        },
    ]
}

fn readout(lang: Lang, buckets: &[Bucket], selected: Option<usize>) -> AnyElement {
    let c = copy(lang);
    let total: f64 = buckets
        .iter()
        .map(|bucket| {
            bucket
                .segments
                .iter()
                .map(|segment| segment.value)
                .sum::<f64>()
        })
        .sum();
    let (label, value): (SharedString, SharedString) =
        match selected.and_then(|index| buckets.get(index)) {
            Some(bucket) => (bucket.label.clone(), bucket.value_text.clone()),
            None => (
                c.total.into(),
                lang.pick(
                    format!("{} tokens", compact_tokens(lang, total)),
                    format!("{} 토큰", compact_tokens(lang, total)),
                )
                .into(),
            ),
        };
    Stack::row()
        .gap(Space::Sm)
        .justify(Justify::Between)
        .child(Typo::caption(label).tone(Tone::Tertiary))
        .child(Typo::caption(value).tabular())
        .into_any_element()
}

/// The selection a demo keeps, and the setter handed to the chart.
fn selection(
    key: &'static str,
    initial: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) -> (
    Option<usize>,
    impl Fn(Option<usize>, &mut Window, &mut App) + 'static,
) {
    let state: Entity<Option<usize>> =
        window.use_keyed_state(sub(key, "selected"), cx, move |_, _| initial);
    let now = *state.read(cx);
    (now, move |next, _, cx| {
        state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    })
}

fn tick_format(lang: Lang) -> impl Fn(f64) -> String + 'static {
    move |value| compact_tokens(lang, value)
}

/// The context-ring popover: hourly buckets since the chat started; `split` adds the legend.
fn popover(
    lang: Lang,
    key: &'static str,
    initial: Option<usize>,
    split: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let slots = if split {
        data::sample_split_slots(7, 2)
    } else {
        data::sample_slots(7, 2)
    };
    let chart = data::chat_chart(lang, &slots);
    let (selected, select) = selection(key, initial, window, cx);
    let emphasis: Entity<Option<Emphasis>> =
        window.use_keyed_state(sub(key, "emphasis"), cx, |_, _| None);
    let now = *emphasis.read(cx);
    let mut stack = Stack::new()
        .gap(Space::Sm)
        .child(readout(lang, &chart.buckets, selected))
        .child(
            UsageBars::new(sub(key, "bars"), chart.buckets.clone(), data::series(lang))
                .axis_labels(chart.axis_labels.clone())
                .selected(selected)
                .on_select(select)
                .emphasis(now)
                .empty_label(c.no_usage),
        );
    if split {
        stack = stack.child(legend(lang, key, &chart, selected, &emphasis, cx));
    }
    stack.into_any_element()
}

/// The usage tab: a fixed window ending now, with y ticks.
fn panel(
    lang: Lang,
    key: &'static str,
    hours: i64,
    initial: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let chart = data::window_chart(lang, &data::sample_slots(hours, 1), hours, Some(31));
    let (selected, select) = selection(key, initial, window, cx);
    Stack::new()
        .gap(Space::Sm)
        .child(readout(lang, &chart.buckets, selected))
        .child(
            UsageBars::new(sub(key, "bars"), chart.buckets.clone(), data::series(lang))
                .size(Size::Panel)
                .axis_labels(chart.axis_labels.clone())
                .y_ticks(tick_format(lang))
                .selected(selected)
                .on_select(select)
                .empty_label(c.no_usage_period),
        )
        .into_any_element()
}

fn split_panel(
    lang: Lang,
    key: &'static str,
    initial: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let chart = data::window_chart(lang, &data::sample_split_slots(168, 1), 168, Some(31));
    let (selected, select) = selection(key, initial, window, cx);
    let emphasis: Entity<Option<Emphasis>> =
        window.use_keyed_state(sub(key, "emphasis"), cx, |_, _| None);
    let now = *emphasis.read(cx);
    Stack::new()
        .gap(Space::Sm)
        .child(readout(lang, &chart.buckets, selected))
        .child(
            UsageBars::new(sub(key, "bars"), chart.buckets.clone(), data::series(lang))
                .size(Size::Panel)
                .axis_labels(chart.axis_labels.clone())
                .y_ticks(tick_format(lang))
                .selected(selected)
                .on_select(select)
                .emphasis(now)
                .empty_label(c.no_usage_period),
        )
        .child(legend(lang, key, &chart, selected, &emphasis, cx))
        .into_any_element()
}

/// Conversation and subtask totals of the selected bucket, or of every bucket.
fn split_totals(buckets: &[Bucket], selected: Option<usize>) -> (f64, f64) {
    let shown: &[Bucket] = match selected {
        Some(index) => buckets.get(index..=index).unwrap_or(&[]),
        None => buckets,
    };
    let segments = shown.iter().flat_map(|bucket| &bucket.segments);
    let (all, sub) = segments.fold((0., 0.), |(all, sub), segment| {
        (all + segment.value, sub + segment.subtask)
    });
    (all - sub, sub)
}

/// The caller's legend: solid conversation and hatched subtask rows, each linked to the chart's emphasis.
fn legend(
    lang: Lang,
    key: &'static str,
    chart: &Chart,
    selected: Option<usize>,
    emphasis: &Entity<Option<Emphasis>>,
    cx: &App,
) -> AnyElement {
    let c = copy(lang);
    let (conversation, subtask) = split_totals(&chart.buckets, selected);
    let percent = |value: f64| {
        format!(
            "{}%",
            (value / (conversation + subtask).max(1.) * 100.).round()
        )
    };
    let color = Ds::get(cx).color(Color::ContextChart5);
    let row = |id: &'static str,
               label: &'static str,
               value: f64,
               pattern: SwatchPattern,
               kind: Emphasis| {
        let emphasis = emphasis.clone();
        KeyValueRow::new(
            label,
            format!("{} · {}", compact_tokens(lang, value), percent(value)),
        )
        .value_size(ValueSize::Caption)
        .swatch_color(color)
        .swatch_pattern(pattern)
        .on_highlight_change(sub(key, id), move |highlighted, _, cx| {
            emphasis.update(cx, |emphasis, cx| {
                *emphasis = highlighted.then_some(kind);
                cx.notify();
            });
        })
    };
    Stack::new()
        .gap(Space::Xs)
        .child(row(
            "conversation",
            c.conversation,
            conversation,
            SwatchPattern::Solid,
            Emphasis::Conversation,
        ))
        .child(row(
            "subtask",
            c.subtask,
            subtask,
            SwatchPattern::Hatched,
            Emphasis::Subtask,
        ))
        .into_any_element()
}

fn split_selected(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Xl)
        .child(popover(
            lang,
            "ub-split-sel-popover",
            Some(2),
            true,
            window,
            cx,
        ))
        .child(split_panel(
            lang,
            "ub-split-sel-panel",
            Some(20),
            window,
            cx,
        ))
        .into_any_element()
}

fn selected(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Xl)
        .child(popover(lang, "ub-sel-popover", Some(2), false, window, cx))
        .child(panel(lang, "ub-sel-panel", 168, Some(20), window, cx))
        .into_any_element()
}

/// A chat whose only usage is the current hour.
fn single(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let slots = [Slot {
        start: butler_ds::ui::blocks::usage_bars::wall_ms(2026, 10, 15, 15, 30),
        values: vec![4_800., 31_900., 3_420.],
    }];
    let chart = data::chat_chart(lang, &slots);
    let bars = |id: &'static str, size: Size| {
        let mut bars = UsageBars::new(id, chart.buckets.clone(), data::series(lang))
            .size(size)
            .axis_labels(chart.axis_labels.clone())
            .note(c.just_started);
        if size == Size::Panel {
            bars = bars.y_ticks(tick_format(lang));
        }
        bars
    };
    Stack::new()
        .gap(Space::Xl)
        .child(bars("ub-single-popover", Size::Popover))
        .child(bars("ub-single-panel", Size::Panel))
        .into_any_element()
}

fn loading(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let bars = |id: &'static str, size: Size| {
        let mut bars = UsageBars::new(id, Vec::new(), data::series(lang))
            .size(size)
            .state(State::Loading)
            .min_slots(if size == Size::Panel { 28 } else { 10 });
        if size == Size::Panel {
            bars = bars.y_ticks(tick_format(lang));
        }
        bars
    };
    Stack::new()
        .gap(Space::Xl)
        .child(bars("ub-loading-popover", Size::Popover))
        .child(bars("ub-loading-panel", Size::Panel))
        .into_any_element()
}

/// Empty: the popover has no buckets yet; the panel keeps its zero buckets so the time axis stays.
fn empty(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let chart = data::window_chart(lang, &data::sample_slots(168, 0), 168, Some(31));
    let zero: Vec<Bucket> = chart
        .buckets
        .iter()
        .cloned()
        .map(|bucket| Bucket {
            segments: Vec::new(),
            ..bucket
        })
        .collect();
    Stack::new()
        .gap(Space::Xl)
        .child(
            UsageBars::new("ub-empty-popover", Vec::new(), data::series(lang))
                .state(State::Empty)
                .empty_label(c.no_usage),
        )
        .child(
            UsageBars::new("ub-empty-panel", zero, data::series(lang))
                .size(Size::Panel)
                .state(State::Empty)
                .axis_labels(chart.axis_labels)
                .empty_label(c.no_usage_period)
                .y_ticks(tick_format(lang)),
        )
        .into_any_element()
}

/// The demo's slots: the sample window plus one slot per response and subtask response added.
fn motion_slots(split: bool, hours: i64, responses: usize, subtasks: usize) -> Vec<Slot> {
    let mut slots: Vec<Slot> = if split {
        data::sample_split_slots(24, 1)
            .into_iter()
            .filter(|slot| slot.start < data::now() - 6 * 3_600_000)
            .collect()
    } else {
        data::sample_slots(hours, 1)
    };
    for index in 0..responses + subtasks {
        let sub = index >= responses;
        let mut values = vec![30_000., 210_000., 9_000.];
        if split {
            values.extend(if sub {
                [20_000., 150_000., 7_000.]
            } else {
                [0., 0., 0.]
            });
        }
        slots.push(Slot {
            start: data::now()
                - SLOT_MS
                    * (1 + if split {
                        i64::try_from(index).unwrap_or(0) * 4
                    } else {
                        0
                    }),
            values,
        });
    }
    slots
}

/// Live update (same bucket count: columns ease), a range switch (new count: columns grow) and a
/// replay (remount). `split` adds a subtask response button.
fn motion(
    lang: Lang,
    key: &'static str,
    split: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    // responses added, the window in hours, the replay round, subtask responses added
    let state: Entity<(usize, i64, usize, usize)> =
        window.use_keyed_state(sub(key, "state"), cx, |_, _| (0, 24, 0, 0));
    let (responses, hours, round, subtasks) = *state.read(cx);
    let slots = motion_slots(split, hours, responses, subtasks);
    let chart = data::window_chart(lang, &slots, hours, Some(31));
    let button =
        |id: &'static str, label: &'static str, change: fn(&mut (usize, i64, usize, usize))| {
            let state = state.clone();
            Button::new(sub(key, id))
                .size(ButtonSize::Sm)
                .variant(Variant::Outline)
                .text(label)
                .on_click(move |_, _, cx| {
                    state.update(cx, |state, cx| {
                        change(state);
                        cx.notify();
                    });
                })
        };
    let mut buttons = Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .child(button("add", c.add, |s| s.0 += 1));
    if split {
        buttons = buttons.child(button("add-subtask", c.add_subtask, |s| s.3 += 1));
    } else {
        buttons = buttons.child(button("range", c.range, |s| {
            s.1 = if s.1 == 24 { 168 } else { 24 }
        }));
    }
    buttons = buttons.child(button("replay", c.replay, |s| {
        *s = (0, if s.1 == 168 && s.3 == 0 { 168 } else { 24 }, s.2 + 1, 0);
    }));
    Stack::new()
        .gap(Space::Md)
        .child(
            UsageBars::new(
                (
                    sub(key, "bars"),
                    SharedString::from(format!("round-{round}")),
                ),
                chart.buckets,
                data::series(lang),
            )
            .size(Size::Panel)
            .axis_labels(chart.axis_labels)
            .y_ticks(tick_format(lang)),
        )
        .child(buttons)
        .into_any_element()
}
