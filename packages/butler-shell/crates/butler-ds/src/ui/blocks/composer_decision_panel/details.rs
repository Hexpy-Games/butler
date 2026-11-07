//! ComposerDecisionDetails.tsx: the detail lines under a decision's title. Every line wraps, so
//! nothing is cut; with both labels a long block clamps to four lines behind an inline button.
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use crate::tokens::Length;
use crate::ui::blocks::markdown_content::CodeFrame;
use crate::ui::blocks::measure;
use crate::ui::button::{Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::scroll::{Axis, ScrollArea};
use crate::ui::typo::{Tone, Typo, Wrap};

/// A detail line, or a command body drawn in a code frame with its own spaces and line breaks.
#[derive(Clone, Debug)]
pub enum Detail {
    Line(SharedString),
    Code(SharedString),
}

impl Detail {
    pub fn line(text: impl Into<SharedString>) -> Self {
        Self::Line(text.into())
    }

    pub fn code(text: impl Into<SharedString>) -> Self {
        Self::Code(text.into())
    }
}

/// The clamp's height, in lines.
const CLAMP_LINES: usize = 4;

/// `{ code }`: monospace in a code frame, scrolling sideways.
fn code_frame(id: ElementId, code: &SharedString, literal: bool, ds: &Ds) -> AnyElement {
    let lines = code.split('\n').map(|line| {
        let text = Typo::code(line.to_owned())
            .tone(Tone::Secondary)
            .wrap(Wrap::Nowrap);
        let text = if literal { text.literal() } else { text };
        div().min_h(ds.len(Length::TypoCodeLineHeight)).child(text)
    });
    let body = div()
        .flex()
        .flex_col()
        .px(ds.len(Length::SpaceMd))
        .children(lines);
    div()
        .my(ds.len(Length::SpaceXs))
        .py(ds.len(Length::SpaceSm))
        .child(CodeFrame::new().child(ScrollArea::new(id).orientation(Axis::X).child(body)))
        .into_any_element()
}

pub(super) struct Labels {
    pub more: SharedString,
    pub less: SharedString,
}

pub(super) fn details(
    id: &ElementId,
    lines: &[Detail],
    literal: bool,
    labels: Option<&Labels>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (seen, recorder) = measure::track((id.clone(), "details"), window, cx);
    let expanded = window.use_keyed_state((id.clone(), "expanded"), cx, |_, _| false);
    let open = *expanded.read(cx);
    let ds = Ds::get(cx);
    let inner = ds.len(Length::IconSizeSm) + ds.len(Length::SpaceSm) + ds.len(Length::SpaceXs);
    let width = (f32::from(seen.width) - f32::from(inner)).max(0.);
    let overflowing = labels.is_some()
        && width > 0.
        && lines
            .iter()
            .map(|line| match line {
                Detail::Line(text) => {
                    measure::wrapped_lines(text, Length::TypoCaptionSize, width, window, cx)
                }
                Detail::Code(code) => code.split('\n').count(),
            })
            .sum::<usize>()
            > CLAMP_LINES;
    let clamped = labels.is_some() && !open;
    let rows = lines.iter().enumerate().map(|(index, line)| match line {
        Detail::Line(text) => {
            let typo = Typo::caption(text.clone())
                .tone(Tone::Secondary)
                .wrap(Wrap::Anywhere);
            if literal { typo.literal() } else { typo }.into_any_element()
        }
        Detail::Code(code) => code_frame(
            (id.clone(), SharedString::from(format!("code-{index}"))).into(),
            code,
            literal,
            ds,
        ),
    });
    let mut stack = div().flex().flex_col().min_w_0().children(rows);
    if clamped {
        stack = stack
            .max_h(ds.len(Length::TypoCaptionLineHeight) * CLAMP_LINES as f32)
            .overflow_hidden();
    }
    let toggle = labels.filter(|_| overflowing || open).map(|labels| {
        let state = expanded.clone();
        Button::new((id.clone(), "toggle"))
            .variant(Variant::Inline)
            .size(Size::Default)
            .text(if open {
                labels.less.clone()
            } else {
                labels.more.clone()
            })
            .on_click(move |_, _, cx| {
                state.update(cx, |open, cx| {
                    *open = !*open;
                    cx.notify();
                });
            })
    });
    div()
        .relative()
        .flex()
        .flex_col()
        .min_w_0()
        .px(ds.len(Length::SpaceXs))
        .pb(ds.len(Length::SpaceSm))
        .pl(ds.len(Length::IconSizeSm) + ds.len(Length::SpaceSm))
        .child(recorder)
        .child(stack)
        .children(toggle)
        .into_any_element()
}
