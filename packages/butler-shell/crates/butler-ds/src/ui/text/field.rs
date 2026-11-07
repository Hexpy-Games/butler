//! The pipeline Input and Textarea share: the colours of each state, the box or underline drawn
//! around the editor, the ring, and the editor itself. The editor is EditableText; a disabled
//! field is plain text (a disabled input takes no focus, selection or caret).
use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, Focusable as _, FontWeight, Hsla,
    IntoElement as _, ParentElement as _, Pixels, SharedString, Window, div,
};
use gpui_elements::editable_text::{EditableTextState, StringStorage, TextChanged};

use std::cell::RefCell;
use std::rc::Rc;

use super::TextSize;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};
use crate::ui::context::Ds;
use crate::ui::motion::Ramp;
use crate::ui::{control, convert, focus};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Look {
    Default,
    Quiet,
    Underline,
    /// No box, border or ring: the editor alone (ComposerCard's editor slot).
    Bare,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shape {
    /// One line; `compact` is the short inline field.
    Line { compact: bool },
    /// Several lines. `rows` sets a taller fixed box, `grow` sizes it to the text up to the cap.
    Area { rows: Option<u32>, grow: bool },
}

/// One field as its component describes it.
pub(super) struct Spec {
    pub(super) id: ElementId,
    pub(super) look: Look,
    pub(super) text_size: TextSize,
    pub(super) shape: Shape,
    pub(super) placeholder: Option<SharedString>,
    pub(super) initial: SharedString,
    pub(super) value: Option<SharedString>,
    pub(super) disabled: bool,
    pub(super) read_only: bool,
    pub(super) invalid: bool,
    pub(super) probe: Option<SharedString>,
    pub(super) on_change: Option<ChangeHandler>,
}

/// `onChange`: the field's text after an edit by the user.
pub(super) type ChangeHandler = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// The editor state of field `id`, created with `initial` the first time.
pub(super) fn state_of(
    id: &ElementId,
    window: &mut Window,
    cx: &mut App,
    initial: &str,
) -> Entity<EditableTextState> {
    let initial = StringStorage::from(initial);
    EditableTextState::use_keyed_init((id.clone(), "text"), window, cx, move |_, _| initial)
}

/// Lengths of one field.
pub(super) struct Metrics {
    pub(super) size: Pixels,
    pub(super) lh: Pixels,
    pub(super) weight: Option<FontWeight>,
    pub(super) radius: Pixels,
    pub(super) border: Pixels,
    pub(super) ring: Pixels,
}

impl Metrics {
    fn of(spec: &Spec, window: &Window, ds: &Ds) -> Self {
        let (size, lh, weight) = match spec.text_size {
            TextSize::Label => (
                ds.len(Length::TypoLabelSize),
                ds.len(Length::TypoLabelLineHeight),
                Some(FontWeight(ds.number(Number::TypoLabelWeight))),
            ),
            TextSize::Inherit => (
                window.text_style().font_size.to_pixels(window.rem_size()),
                window.line_height(),
                None,
            ),
        };
        Self {
            size,
            lh,
            weight,
            radius: ds.len(Length::RadiusControl),
            border: ds.len(Length::BorderHairline),
            ring: ds.len(Length::FocusRingWidth),
        }
    }
}

/// The colours of a field in its current state.
pub(super) struct Colors {
    pub(super) text: Hsla,
    pub(super) placeholder: Hsla,
    pub(super) fill: Hsla,
    pub(super) border: Hsla,
    /// The underline field's line.
    pub(super) line: Hsla,
}

impl Colors {
    /// `focus` is how far the focus treatment has come (0 to 1; the quiet field fades it in).
    fn of(spec: &Spec, focus: f32, hovered: bool, ds: &Ds) -> Self {
        let transparent = gpui::transparent_black();
        let line = ds.color(Color::Line);
        let raised = convert::with_alpha(ds.color(Color::SurfaceRaised), 0.92);
        let text = if spec.disabled {
            ds.color(Color::InteractiveDisabledFg)
        } else if spec.look == Look::Underline && spec.read_only {
            ds.color(Color::TextSecondary)
        } else {
            ds.color(Color::TextPrimary)
        };
        let focused_border = convert::mix(ds.color(Color::Accent), line, 0.52);
        let mut border = convert::mix(focused_border, line, focus);
        if spec.invalid {
            border = ds.color(Color::ColorDangerBorder);
        }
        let fill = match (spec.look, spec.disabled) {
            (Look::Quiet, true) | (Look::Bare, _) => transparent,
            (Look::Quiet, false) => convert::mix(raised, transparent, focus),
            (_, true) => ds.color(Color::ColorDisabledBg),
            (_, false) => raised,
        };
        Self {
            text,
            placeholder: ds.color(Color::Placeholder),
            fill,
            border,
            line: underline_color(spec, focus > 0.5, hovered, ds),
        }
    }
}

fn underline_color(spec: &Spec, focused: bool, hovered: bool, ds: &Ds) -> Hsla {
    if spec.disabled {
        ds.color(Color::Line)
    } else if focused {
        ds.color(Color::ColorActionPrimary)
    } else if spec.invalid {
        ds.color(Color::ColorDangerBorder)
    } else if hovered && !spec.read_only {
        ds.color(Color::LineStrong)
    } else {
        ds.color(Color::Line)
    }
}

/// The focus treatment's progress: instant for the default field, eased for the quiet one.
fn focus_progress(spec: &Spec, focused: bool, window: &mut Window, cx: &mut App) -> f32 {
    let target = f32::from(u8::from(focused));
    if spec.look != Look::Quiet {
        return target;
    }
    let ramp = window.use_keyed_state((spec.id.clone(), "quiet"), cx, |_, _| Ramp::at(0.));
    let now = cx.background_executor().now();
    let ds = Ds::get(cx);
    let (duration, ease, instant) = (
        ds.duration(DsDuration::MotionFast),
        convert::easing(ds.tokens().ease(Easing::MotionEaseStandard)),
        ds.reduced_motion(),
    );
    let (value, moving) = ramp.update(cx, |ramp, _| {
        ramp.retarget(target, now, instant);
        ramp.sample(now, duration, &ease)
    });
    if moving {
        window.request_animation_frame();
    }
    value
}

/// The pieces a layout puts together.
pub(super) struct Parts {
    pub(super) spec: Spec,
    pub(super) m: Metrics,
    pub(super) c: Colors,
    pub(super) state: Entity<EditableTextState>,
    pub(super) handle: FocusHandle,
    pub(super) focused: bool,
    pub(super) ring: bool,
    pub(super) anchor: SharedString,
}

pub(super) fn render(spec: Spec, window: &mut Window, cx: &mut App) -> AnyElement {
    let state = state_of(&spec.id, window, cx, &spec.initial);
    listen(&spec, &state, window, cx);
    if let Some(value) = &spec.value
        && state.read(cx).as_str() != value.as_ref()
    {
        state.update(cx, |state, cx| state.emplace(value, cx));
    }
    let handle = focus::tab_stop(&state.read(cx).focus_handle(cx), true);
    let focused = handle.is_focused(window) && !spec.disabled;
    let progress = focus_progress(&spec, focused, window, cx);
    let hover = window.use_keyed_state((spec.id.clone(), "hover"), cx, |_, _| false);
    let hovered = *hover.read(cx);
    let anchor = control::next_anchor(cx, (!spec.disabled).then_some(&handle));
    if !spec.disabled {
        super::register(cx, handle.clone(), state.clone());
    }
    let ds = Ds::get(cx);
    let ring = focused && !focus::ring_handed_off(cx);
    let parts = Parts {
        m: Metrics::of(&spec, window, ds),
        c: Colors::of(&spec, progress, hovered, ds),
        spec,
        state,
        handle,
        focused,
        ring,
        anchor,
    };
    let probe = parts
        .spec
        .probe
        .clone()
        .map(|name| (name, parts.state.clone()));
    let el = super::layout::build(&parts, &hover, window, cx);
    match probe {
        Some((name, state)) => div()
            .child(el)
            .children(super::reveal::probe(&name, &state, window, cx))
            .into_any_element(),
        None => el,
    }
}

/// Reports the user's edits to `on_change`. One subscription lives as long as the field; the
/// handler is the latest the owner passed, read when the edit arrives.
fn listen(spec: &Spec, state: &Entity<EditableTextState>, window: &mut Window, cx: &mut App) {
    type Slot = Rc<RefCell<Option<ChangeHandler>>>;
    let slot = window
        .use_keyed_state((spec.id.clone(), "on-change"), cx, |_, _| Slot::default())
        .read(cx)
        .clone();
    slot.borrow_mut().clone_from(&spec.on_change);
    window.use_keyed_state((spec.id.clone(), "on-change-sub"), cx, {
        let (slot, state) = (slot.clone(), state.clone());
        move |window, cx| {
            window.subscribe(&state, cx, move |state, _: &TextChanged, window, cx| {
                let handler = slot.borrow().clone();
                if let Some(handler) = handler {
                    let text = state.read(cx).as_str().to_owned();
                    handler(&text, window, cx);
                }
            })
        }
    });
}
