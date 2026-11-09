//! The trace stories (`SpanBar.showcaseParts.tsx`): `TraceStepRow` and `GeminiTrace`,
//! `RowIndentTrace`, `PlainIndentTrace`.
use std::collections::HashSet;

use butler_ds::ui::blocks::disclosure_row::{Affordance, Attention, DisclosureRow, Surface};
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::blocks::span_bar::{
    SpanAxis, SpanBar, SpanIndent, SpanInset, SpanRow, SpanSegment, SpanTone, span_rows,
};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, SharedString, Window,
};

use super::data::{OPEN, STEPS, Step, TOTAL, children, depth, find, format_ms, start_text};
use crate::copy::Lang;

type Toggle = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

fn spoken(lang: Lang, step: &Step) -> String {
    let start = start_text(lang, step.offset);
    let length = format_ms(lang, step.duration);
    lang.pick(
        format!("Starts {start}, {length}"),
        format!("시작 {start}, {length}"),
    )
}

/// `StepMeta`: an optional status Tag beside the length; never truncated.
fn meta(lang: Lang, step: &Step) -> AnyElement {
    let tag = step.tag.map(|(text, tone)| {
        Tag::new(
            SharedString::from(format!("span-tag-{}", step.id)),
            lang.pick(text.0, text.1),
        )
        .size(TagSize::Sm)
        .tone(tone)
    });
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .children(tag)
        .child(
            Typo::caption(format_ms(lang, step.duration))
                .tone(Tone::Tertiary)
                .tabular(),
        )
        .into_any_element()
}

fn facts(lang: Lang, step: &Step) -> Option<AnyElement> {
    (!step.facts.is_empty()).then(|| {
        Stack::new()
            .gap(Space::Xs)
            .children(step.facts.iter().map(|(label, value)| {
                KeyValueRow::new(lang.pick(label.0, label.1), lang.pick(value.0, value.1))
                    .value_size(ValueSize::Caption)
            }))
            .into_any_element()
    })
}

fn bar(lang: Lang, step: &Step, index: usize, segments: bool) -> SpanBar {
    let pieces = children(step.id)
        .filter(|_| segments)
        .map(|child| SpanSegment {
            offset: child.offset,
            duration: child.duration,
            tone: child.tone(),
        });
    SpanBar::new(
        SharedString::from(format!("span-bar-{}", step.id)),
        step.offset,
        step.duration,
        TOTAL,
    )
    .tone(step.tone())
    .segments(pieces)
    .index(index)
    .label(spoken(lang, step))
}

fn depth_cue(lang: Lang) -> impl Fn(u32) -> SharedString + 'static {
    move |level| {
        lang.pick(format!("Depth {level}"), format!("깊이 {level}"))
            .into()
    }
}

/// `TraceStepRow`: no chevron, a count and a problem dot by the title, a segmented bar over its
/// children.
fn step_row(lang: Lang, step: &Step, index: usize, open: bool, toggle: Toggle) -> SpanRow {
    let span = SpanRow::new(SharedString::from(format!("span-row-{}", step.id)))
        .depth(depth(step))
        .indent(SpanIndent::Text)
        .depth_label(depth_cue(lang));
    let (level, cue) = span.text_indent();
    let kids = children(step.id).count();
    let mut row = DisclosureRow::new(
        SharedString::from(format!("span-step-{}", step.id)),
        lang.pick(step.title.0, step.title.1),
    )
    .affordance(Affordance::None)
    .description(start_text(lang, step.offset))
    .meta_element(meta(lang, step))
    .indent(level, cue)
    .open(open)
    .on_toggle(toggle)
    .bar(bar(lang, step, index, true));
    if kids > 0 {
        row = row.count(u32::try_from(kids).unwrap_or(u32::MAX));
    }
    row = match step.problem {
        Some(SpanTone::Error) => row.attention(Attention::Error),
        Some(_) => row.attention(Attention::Warning),
        None => row,
    };
    match facts(lang, step) {
        Some(facts) => span.child(row.child(facts)),
        None => span.child(row),
    }
}

/// A step is shown while every ancestor is open.
fn shown(step: &Step, open: &HashSet<&'static str>) -> bool {
    let mut parent = step.parent;
    while let Some(next) = parent {
        if !open.contains(next) {
            return false;
        }
        parent = find(next).and_then(|found| found.parent);
    }
    true
}

/// `GeminiTrace`: the axis over trace steps; a parent shows its child steps while open.
pub(super) fn gemini(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let state = window.use_keyed_state("span-gemini-open", cx, |_, _| {
        OPEN.iter().copied().collect::<HashSet<&'static str>>()
    });
    let open = state.read(cx).clone();
    let rows = STEPS
        .iter()
        .filter(|step| shown(step, &open))
        .enumerate()
        .map(|(index, step)| {
            let (id, state) = (step.id, state.clone());
            let toggle: Toggle = Box::new(move |_, _, cx| {
                state.update(cx, |open, cx| {
                    if !open.remove(id) {
                        open.insert(id);
                    }
                    cx.notify();
                });
            });
            step_row(lang, step, index, open.contains(step.id), toggle)
        });
    Stack::new()
        .gap(Space::Sm)
        .child(
            SpanAxis::new("span-gemini-axis", TOTAL)
                .inset(SpanInset::Row)
                .format(move |ms| format_ms(lang, ms)),
        )
        .child(span_rows(rows))
        .into_any_element()
}

/// A one-open-at-a-time toggle for the step `id`, held in `state`.
fn exclusive(
    state: &gpui::Entity<Option<&'static str>>,
    id: &'static str,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let state = state.clone();
    move |_, _, cx| {
        state.update(cx, |current, cx| {
            *current = if *current == Some(id) { None } else { Some(id) };
            cx.notify();
        });
    }
}

/// `PlainIndentTrace`: plain rows in text-indent `SpanRow`s, static and interactive, keep the
/// 8px start inset at every depth.
pub(super) fn plain(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let state = window.use_keyed_state("span-plain-open", cx, |_, _| None::<&'static str>);
    let current = *state.read(cx);
    let steps = (0..=4).filter_map(|level| STEPS.iter().find(|step| depth(step) == level));
    let rows = steps.enumerate().flat_map(|(index, step)| {
        [true, false].map(|interactive| {
            let span = SpanRow::new(SharedString::from(format!(
                "span-plain-{}-{interactive}",
                step.id
            )))
            .depth(depth(step))
            .indent(SpanIndent::Text)
            .depth_label(depth_cue(lang));
            let (level, cue) = span.text_indent();
            let mut row = DisclosureRow::new(
                SharedString::from(format!("span-plain-step-{}-{interactive}", step.id)),
                lang.pick(step.title.0, step.title.1),
            )
            .surface(Surface::Plain)
            .affordance(Affordance::None)
            .description(start_text(lang, step.offset))
            .meta(format_ms(lang, step.duration))
            .indent(level, cue)
            .open(current == Some(step.id) && interactive)
            .on_toggle(exclusive(&state, step.id))
            .bar(bar(lang, step, index, false));
            if interactive {
                row = row.count(u32::try_from(children(step.id).count().max(1)).unwrap_or(1));
            }
            span.child(row)
        })
    });
    Stack::new()
        .gap(Space::Sm)
        .child(
            SpanAxis::new("span-plain-axis", TOTAL)
                .inset(SpanInset::Row)
                .format(move |ms| format_ms(lang, ms)),
        )
        .child(span_rows(rows))
        .into_any_element()
}

/// `RowIndentTrace`: the whole row indents and its bar lines up with the shared axis.
pub(super) fn row_indent(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let state = window.use_keyed_state("span-row-open", cx, |_, _| None::<&'static str>);
    let current = *state.read(cx);
    let steps: Vec<&Step> = ["turn", "req-2", "http-2", "stream"]
        .into_iter()
        .filter_map(find)
        .collect();
    let max_depth = steps.iter().map(|step| depth(step)).max().unwrap_or(0);
    let rows = steps.iter().enumerate().map(|(index, step)| {
        let span = SpanRow::new(SharedString::from(format!("span-indent-{}", step.id)))
            .depth(depth(step))
            .max_depth(max_depth);
        let reach = span.reach(cx);
        let mut row = DisclosureRow::new(
            SharedString::from(format!("span-indent-step-{}", step.id)),
            lang.pick(step.title.0, step.title.1),
        )
        .meta(format_ms(lang, step.duration))
        .open(current == Some(step.id))
        .on_toggle(exclusive(&state, step.id))
        .description(start_text(lang, step.offset))
        .bar(bar(lang, step, index, false).reach(reach));
        if let Some((label, value)) = step.facts.first() {
            row = row.child(
                KeyValueRow::new(lang.pick(label.0, label.1), lang.pick(value.0, value.1))
                    .value_size(ValueSize::Caption),
            );
        }
        span.child(row)
    });
    Stack::new()
        .gap(Space::Sm)
        .child(
            SpanAxis::new("span-indent-axis", TOTAL)
                .inset(SpanInset::Disclosure)
                .max_depth(max_depth)
                .format(move |ms| format_ms(lang, ms)),
        )
        .child(span_rows(rows))
        .into_any_element()
}
