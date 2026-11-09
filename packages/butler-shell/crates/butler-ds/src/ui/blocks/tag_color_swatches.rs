//! DS TagColorSwatches (TagColorSwatches.tsx / TagColorSwatches.module.css): picks a Tag label
//! tone. A radio group of round swatches, each a miniature of its Tag: the tone's fill and
//! border with a dot in its ink, or the check when chosen. The arrows move and select (Home and
//! End jump) and wrap; only the chosen swatch is a tab stop. The chosen ring, the hover ring and
//! the focus ring all draw inside the swatch's own box, so no clipping container cuts them.
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, ElementId, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::icon::{IconSize, icon};
use crate::ui::motion::{Props, Timing, transition};
use crate::ui::tag::LabelTone;
use crate::ui::tooltip::Tooltip;

type Handler = Rc<dyn Fn(LabelTone, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct TagColorSwatches {
    id: ElementId,
    value: LabelTone,
    tones: Vec<LabelTone>,
    labels: Vec<(LabelTone, SharedString)>,
    on_change: Option<Handler>,
}

impl TagColorSwatches {
    /// `value` is the chosen tone (store the tone, never a colour value).
    pub fn new(id: impl Into<ElementId>, value: LabelTone) -> Self {
        Self {
            id: id.into(),
            value,
            tones: LabelTone::ALL.to_vec(),
            labels: Vec::new(),
            on_change: None,
        }
    }

    /// The tones offered, in order (every label tone by default).
    pub fn tones(mut self, tones: impl IntoIterator<Item = LabelTone>) -> Self {
        self.tones = tones.into_iter().collect();
        self
    }

    /// Each tone's name ("Blue", "파랑"): its tooltip.
    pub fn labels(mut self, name: impl Fn(LabelTone) -> SharedString) -> Self {
        self.labels = LabelTone::ALL
            .iter()
            .map(|tone| (*tone, name(*tone)))
            .collect();
        self
    }

    pub fn on_value_change(
        mut self,
        handler: impl Fn(LabelTone, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for TagColorSwatches {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let stop = self
            .tones
            .iter()
            .position(|tone| *tone == self.value)
            .unwrap_or(0);
        let mut items = Vec::new();
        let mut handles = Vec::new();
        for (index, tone) in self.tones.iter().copied().enumerate() {
            let (item, handle) = self.swatch(index, tone, index == stop, window, cx);
            items.push(item);
            handles.push(handle);
        }
        let mut group = div()
            .flex()
            .flex_wrap()
            .items_center()
            .min_w_0()
            .gap(Ds::get(cx).len(Length::SpaceXs));
        if let Some(handler) = self.on_change.clone() {
            let (tones, value) = (self.tones.clone(), self.value);
            group = group.on_key_down(move |event, window, cx| {
                roving(
                    &event.keystroke.key,
                    (&handles, &tones, value),
                    &handler,
                    window,
                    cx,
                );
            });
        }
        group.children(items)
    }
}

impl TagColorSwatches {
    /// One swatch in its tooltip, and its focus handle (the group moves focus between them).
    fn swatch(
        &self,
        index: usize,
        tone: LabelTone,
        tab_stop: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> (AnyElement, FocusHandle) {
        let id: ElementId = SharedString::from(format!("{}-{index}", self.id)).into();
        let handle = window
            .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let state = window.use_keyed_state((id.clone(), "hover"), cx, |_, _| false);
        let ds = Ds::get(cx);
        let timing = if ds.reduced_motion() {
            Timing::linear(Duration::ZERO)
        } else {
            Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard)
        };
        let hover = transition(
            (id.clone(), "hover-ring"),
            (f32::from(*state.read(cx)), false),
            &timing,
            window,
            cx,
        );
        let focused = focus::visible(Ds::get(cx), handle.is_focused(window), false);
        let ds = Ds::get(cx);
        let checked = tone == self.value;
        let side = ds.len(if ds.compact() {
            Length::ControlHitTarget
        } else {
            Length::ControlHeightSm
        });
        let ink = ds.color(tone.tokens().2);
        let chip = chip(tone, checked, ds);
        let ring = ring(focused, checked, (hover, timing), ds);
        let mut swatch = div()
            .id(id.clone())
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(side)
            .rounded_full()
            .cursor_pointer()
            .text_color(ink)
            .track_focus(&focus::tab_stop(&handle, tab_stop))
            .on_hover(move |on, _, cx| {
                state.update(cx, |s, cx| {
                    *s = *on;
                    cx.notify();
                });
            })
            .child(chip)
            .child(ring);
        if let (Some(handler), false) = (self.on_change.clone(), checked) {
            swatch = swatch.on_click(move |_, window, cx| handler(tone, window, cx));
        }
        let label = self
            .labels
            .iter()
            .find(|(t, _)| *t == tone)
            .map(|(_, name)| name.clone());
        let tip = Tooltip::new(SharedString::from(format!("{id}-tip")))
            .child(swatch)
            .label(label.unwrap_or_default());
        (tip.into_any_element(), handle)
    }
}

/// The round miniature of the tag: its fill and border, with a dot in its ink or the check.
fn chip(tone: LabelTone, checked: bool, ds: &Ds) -> gpui::Div {
    let (border, bg, fg) = tone.tokens();
    let side = ds.len(Length::ControlHeightSm) - ds.len(Length::SpaceSm);
    let mark = if checked {
        icon(Icon::CheckIcon, IconSize::Sm, ds).into_any_element()
    } else {
        div()
            .size(ds.len(Length::SpaceSm))
            .rounded_full()
            .bg(ds.color(fg))
            .into_any_element()
    };
    div()
        .flex()
        .items_center()
        .justify_center()
        .size(side)
        .rounded_full()
        .bg(ds.color(bg))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(border))
        .child(mark)
}

/// The ring inside the swatch's box: focus, else chosen, else the hover hairline fading in.
fn ring(
    focused: bool,
    checked: bool,
    (hover, timing): (crate::ui::motion::Transition, Timing),
    ds: &Ds,
) -> gpui::Div {
    let (width, color) = if focused {
        (
            ds.len(Length::FocusRingWidth),
            ds.color(Color::ColorActionPrimary),
        )
    } else if checked {
        (
            ds.len(Length::BorderWidthStrong),
            ds.color(Color::TextPrimary),
        )
    } else {
        (ds.len(Length::BorderHairline), ds.color(Color::LineStrong))
    };
    let ring = div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded_full()
        .border(width)
        .border_color(color);
    if focused || checked {
        ring
    } else {
        hover.apply(
            ring,
            &timing,
            &Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        )
    }
}

/// Arrow, Home and End keys: focus and choose the target swatch (the arrows wrap).
fn roving(
    key: &str,
    (handles, tones, value): (&[FocusHandle], &[LabelTone], LabelTone),
    on_change: &Handler,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(here) = handles.iter().position(|handle| handle.is_focused(window)) else {
        return;
    };
    let count = handles.len();
    let target = match key {
        "right" | "down" => (here + 1) % count,
        "left" | "up" => (here + count - 1) % count,
        "home" => 0,
        "end" => count - 1,
        _ => return,
    };
    cx.stop_propagation();
    if let (Some(handle), Some(tone)) = (handles.get(target), tones.get(target)) {
        window.focus(handle, cx);
        if *tone != value {
            on_change(*tone, window, cx);
        }
    }
}
