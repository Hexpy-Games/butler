//! ResizeGrip and the resize handle (ResizeGrip.tsx / ResizeGrip.module.css): a 9px grab zone
//! over a divider. A 4x64 pill grabber shows on hover, focus and drag, and with a hint a
//! two-line tooltip beside it after about the Tooltip delay (2 x `--motion-deliberate`), on the
//! workspace side of the divider.
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, CursorStyle, DispatchPhase, ElementId, Entity, InteractiveElement as _,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, canvas, div, px,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing, Transition, transition};
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use crate::ui::typo::{Role, Tone, Typo, Weight};
use crate::ui::{focus, strut};

/// The grab zone's width, centred on the divider.
pub const HANDLE_WIDTH: f32 = 9.; // DS: AdaptiveShell.module.css:174
/// The grabber: 4px by 64px.
const GRIP_WIDTH: f32 = 4.; // DS: ResizeGrip.module.css:8
const GRIP_HEIGHT: f32 = 64.; // DS: ResizeGrip.module.css:9
/// The grabber scales up from 60% of its height.
const GRIP_REST_SCALE: f32 = 0.6; // DS: ResizeGrip.module.css:14
/// The hint's width cap and its gap to the grabber's edge.
const HINT_MAX_WIDTH: f32 = 240.; // DS: ResizeGrip.module.css:43
const HINT_GAP: f32 = 2.; // DS: ResizeGrip.module.css:61

/// Which side of the divider the hint sits on, in reading order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintSide {
    /// Left of the divider.
    Start,
    /// Right of the divider.
    End,
}

/// One phase of a drag along the handle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Drag {
    Begin,
    /// The pointer's travel from where it was pressed, in px.
    Move(f32),
    End,
}

pub type DragHandler = Rc<dyn Fn(Drag, &mut Window, &mut App)>;
pub type KeyHandler = Rc<dyn Fn(&KeyDownEvent, &mut Window, &mut App)>;

#[derive(Default, Clone, Copy)]
struct Pointer {
    hover_since: Option<Instant>,
    /// The x of the press, while dragging.
    dragging: Option<f32>,
}

#[derive(IntoElement)]
pub struct ResizeHandle {
    id: ElementId,
    label: Option<SharedString>,
    hint: Option<SharedString>,
    hint_side: HintSide,
    locked: bool,
    on_drag: Option<DragHandler>,
    on_key: Option<KeyHandler>,
}

impl ResizeHandle {
    pub fn new(id: impl Into<ElementId>, hint_side: HintSide) -> Self {
        Self {
            id: id.into(),
            label: None,
            hint: None,
            hint_side,
            locked: false,
            on_drag: None,
            on_key: None,
        }
    }

    /// The accessible name and the hint's first line ("Resize conversation").
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The hint's second line ("Drag to resize").
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// A handle that does not resize: no grabber, a default cursor.
    pub fn locked(mut self, locked: bool) -> Self {
        self.locked = locked;
        self
    }

    pub fn on_drag(mut self, handler: impl Fn(Drag, &mut Window, &mut App) + 'static) -> Self {
        self.on_drag = Some(Rc::new(handler));
        self
    }

    pub fn on_key_down(
        mut self,
        handler: impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_key = Some(Rc::new(handler));
        self
    }
}

/// Follows the pointer for a drag that began on the handle, wherever it goes (pointer capture).
fn capture(
    pointer: &Entity<Pointer>,
    on_drag: Option<&DragHandler>,
    window: &mut Window,
    bounds: gpui::Bounds<gpui::Pixels>,
) {
    let (down, moved, up) = (pointer.clone(), pointer.clone(), pointer.clone());
    let (begin, follow, end) = (on_drag.cloned(), on_drag.cloned(), on_drag.cloned());
    window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
        let inside = bounds.contains(&event.position);
        if phase != DispatchPhase::Bubble || event.button != MouseButton::Left || !inside {
            return;
        }
        let Some(begin) = begin.as_ref() else {
            return;
        };
        down.update(cx, |state, _| {
            state.dragging = Some(f32::from(event.position.x));
        });
        begin(Drag::Begin, window, cx);
        cx.stop_propagation();
    });
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
        let start = moved.read(cx).dragging;
        if let (DispatchPhase::Bubble, Some(start), Some(follow)) = (phase, start, follow.as_ref())
        {
            follow(Drag::Move(f32::from(event.position.x) - start), window, cx);
        }
    });
    window.on_mouse_event(move |_: &MouseUpEvent, _, window, cx| {
        if up.read(cx).dragging.is_some() {
            up.update(cx, |state, _| state.dragging = None);
            if let Some(end) = end.as_ref() {
                end(Drag::End, window, cx);
            }
        }
    });
}

fn hint_view(
    label: Option<SharedString>,
    hint: SharedString,
    side: HintSide,
    ds: &Ds,
) -> AnyElement {
    let gap = px(HINT_GAP) + ds.len(Length::SpaceSm);
    let lines = div()
        .grid()
        .gap(px(2.)) // DS: ResizeGrip.module.css:46
        .children(label.map(|title| {
            Typo::new(Role::Label, title)
                .tone(Tone::Primary)
                .weight(Weight::Medium)
        }))
        .child(
            Typo::new(Role::Label, hint)
                .tone(Tone::Secondary)
                .weight(Weight::Regular),
        );
    let glass = TintedGlass::new()
        .radius(GlassRadius::Control)
        .padding(GlassPadding::None)
        .child(
            div()
                .px(ds.len(Length::SpaceSm))
                .py(ds.len(Length::SpaceXs))
                .whitespace_nowrap()
                .child(lines),
        );
    let el = div()
        .absolute()
        .top(px(0.))
        .bottom(px(0.))
        .flex()
        .items_center()
        .max_w(px(HINT_MAX_WIDTH));
    match side {
        HintSide::End => el.left(px(HANDLE_WIDTH / 2.) + gap),
        HintSide::Start => el.right(px(HANDLE_WIDTH / 2.) + gap),
    }
    .child(glass)
    .into_any_element()
}

/// How visible the grabber and the hint are this frame, and whether a drag is under way.
struct Shown {
    grip: (Transition, Timing),
    hint: (Transition, Timing),
    dragging: bool,
}

impl ResizeHandle {
    /// The grabber and the hint ease in on hover, focus and drag; the hint waits out the tooltip
    /// delay on hover, shows at once on focus and steps aside while dragging.
    fn shown(
        &self,
        (pointer, focused): (&Entity<Pointer>, bool),
        window: &mut Window,
        cx: &mut App,
    ) -> Shown {
        let now = cx.background_executor().now();
        let ds = Ds::get(cx);
        let state = *pointer.read(cx);
        let dragging = state.dragging.is_some();
        let live = !self.locked;
        let grip_shown = live && (state.hover_since.is_some() || focused || dragging);
        let delay = hint_delay(ds);
        let hint_due = state
            .hover_since
            .is_some_and(|since| now.saturating_duration_since(since) >= delay);
        let hint_shown = live && !dragging && (hint_due || focused);
        if state.hover_since.is_some() && !hint_due && !dragging {
            window.request_animation_frame();
        }
        let fast = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
        let enter = Timing::token(ds, DsDuration::MotionEnterMenu, Easing::MotionEaseEnter);
        let exit = Timing::token(ds, DsDuration::MotionExitFast, Easing::MotionEaseAccelerate);
        let level = |on: bool| f32::from(u8::from(on));
        let reduced = ds.reduced_motion();
        let before =
            window.use_keyed_state((self.id.clone(), "grip-target"), cx, |_, _| grip_shown);
        if *before.read(cx) != grip_shown {
            if !reduced {
                window.animate_layout(fast.ms());
            }
            before.update(cx, |value, _| *value = grip_shown);
        }
        let grip = transition(
            (self.id.clone(), "grip"),
            (level(grip_shown), false),
            &fast,
            window,
            cx,
        );
        let timing = if hint_shown { &enter } else { &exit };
        let hint = transition(
            (self.id.clone(), "hint"),
            (level(hint_shown), dragging),
            timing,
            window,
            cx,
        );
        Shown {
            grip: (grip, fast),
            hint: (hint, *timing),
            dragging,
        }
    }
}

/// The 4x64 pill, centred on the divider; it scales up from 60% of its height as it shows.
fn pill(id: ElementId, shown: &Shown, ds: &Ds) -> gpui::Stateful<gpui::Div> {
    let scale = if ds.reduced_motion() {
        1.
    } else {
        GRIP_REST_SCALE + (1. - GRIP_REST_SCALE) * shown.grip.0.target()
    };
    let color = if shown.dragging {
        Color::TextSecondary
    } else {
        Color::TextTertiary
    };
    shown.grip.0.apply(
        div()
            .id((id, "pill"))
            .layout_motion(gpui::LayoutMotion {
                duration_ms: if ds.reduced_motion() {
                    0
                } else {
                    shown.grip.1.ms()
                },
                easing: shown.grip.1.easing(),
            })
            .absolute()
            .top(gpui::relative(0.5))
            .left(gpui::relative(0.5))
            .ml(px(-GRIP_WIDTH / 2.))
            .mt(px(-GRIP_HEIGHT * scale / 2.))
            .w(px(GRIP_WIDTH))
            .h(px(GRIP_HEIGHT * scale))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(color)),
        &shown.grip.1,
        &Props {
            opacity: Some((0., 1.)),
            ..Default::default()
        },
    )
}

impl RenderOnce for ResizeHandle {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let pointer =
            window.use_keyed_state((self.id.clone(), "pointer"), cx, |_, _| Pointer::default());
        let focus_handle =
            window.use_keyed_state((self.id.clone(), "focus"), cx, |_, cx| cx.focus_handle());
        let live = !self.locked;
        let tracked = focus::tab_stop(focus_handle.read(cx), live && self.on_key.is_some());
        let focused = focus::visible(Ds::get(cx), tracked.is_focused(window), false);
        let shown = self.shown((&pointer, focused), window, cx);
        let ds = Ds::get(cx);
        let hint = self
            .hint
            .clone()
            .filter(|_| shown.hint.0.target() > 0. || shown.hint.0.moving(&shown.hint.1))
            .map(|hint| {
                shown.hint.0.apply(
                    div().absolute().size_full().child(hint_view(
                        self.label.clone(),
                        hint,
                        self.hint_side,
                        ds,
                    )),
                    &shown.hint.1,
                    &Props {
                        opacity: Some((0., 1.)),
                        ..Default::default()
                    },
                )
            });
        let (hover, bounds_state) = (pointer.clone(), pointer);
        let (on_drag, on_key) = (self.on_drag.clone(), self.on_key.clone());
        let mut el = div()
            .id(self.id.clone())
            .relative()
            .w(px(HANDLE_WIDTH))
            .flex_none()
            .h_full()
            .cursor(if live {
                CursorStyle::ResizeLeftRight
            } else {
                CursorStyle::Arrow
            })
            .on_hover(move |on, window, cx| {
                let now = cx.background_executor().now();
                hover.update(cx, |state, _| {
                    state.hover_since = on.then(|| state.hover_since.unwrap_or(now));
                });
                window.refresh();
            })
            .child(pill(self.id.clone(), &shown, ds))
            .children(hint);
        if live && on_key.is_some() {
            el = el.track_focus(&tracked);
        }
        if let Some(on_key) = on_key.filter(|_| live) {
            el = el.on_key_down(move |event, window, cx| on_key(event, window, cx));
        }
        let recorder = canvas(
            |bounds, _, _| bounds,
            move |_, bounds, window, _| {
                if live {
                    capture(&bounds_state, on_drag.as_ref(), window, bounds);
                }
            },
        )
        .absolute()
        .size_full();
        strut::scope(false, el.child(recorder))
    }
}

/// The duration a hint waits before it shows, for the harness to wait out.
pub fn hint_delay(ds: &Ds) -> Duration {
    ds.duration(DsDuration::MotionDeliberate) * 2
}
