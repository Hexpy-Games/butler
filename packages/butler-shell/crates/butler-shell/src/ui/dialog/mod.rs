//! A modal dialog on a native glass sheet: a centred title between round 44 pt glass buttons,
//! the caller's body, and text buttons at the bottom right. It opens and closes over 200 ms
//! (scale 0.94 -> 1 and fade); its buttons press like native ones ([`crate::ui::glass::press`]) and
//! report activations. The shell lays it over the chat card and draws the
//! veil under it.
mod buttons;

use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Context, DispatchPhase, EventEmitter, FontWeight, MouseButton, MouseMoveEvent,
    MouseUpEvent, SharedString, Window, canvas, div, prelude::*, px,
};

use crate::ui::composer::Submit;
use crate::ui::glass::{self, Native, press::Presses};
use crate::ui::motion::{Hover, cubic_bezier};
use crate::ui::theme::Theme;
use crate::ui::widgets::{HasHover, text};

/// Open and close: 200 ms.
const OPEN: Duration = Duration::from_millis(200);
const RADIUS: f32 = 24.;
pub(crate) const BUTTON: f32 = 44.;

/// The dialog's body, built at the dialog's current scale (1 when open).
pub(crate) type Body = Box<dyn Fn(&Theme, f32) -> AnyElement>;

pub(crate) struct DialogSpec {
    pub(crate) title: SharedString,
    /// Round buttons: one on the left, the rest on the right (key, glyph).
    pub(crate) leading: Option<(&'static str, &'static str)>,
    pub(crate) trailing: Vec<(&'static str, &'static str)>,
    pub(crate) body: Body,
    /// Text buttons (key, label, primary), left to right.
    pub(crate) actions: Vec<(&'static str, &'static str, bool)>,
    pub(crate) size: (f32, f32),
}

/// One of the dialog's buttons was activated (its key); the host decides and closes.
pub(crate) struct Activated(pub(crate) &'static str);

pub(crate) struct Dialog {
    spec: DialogSpec,
    pub(crate) theme: Theme,
    open: bool,
    /// When the dialog last opened or closed.
    changed: Option<Instant>,
    presses: Presses,
    hover: Hover,
}

impl EventEmitter<Activated> for Dialog {}

impl HasHover for Dialog {
    fn hover_state(&mut self) -> &mut Hover {
        &mut self.hover
    }
}

impl Dialog {
    pub(crate) fn new(spec: DialogSpec, theme: Theme, cx: &App) -> Self {
        Self {
            spec,
            theme,
            open: true,
            changed: Some(cx.background_executor().now()),
            presses: Presses::default(),
            hover: Hover::default(),
        }
    }

    pub(crate) fn size(&self) -> (f32, f32) {
        self.spec.size
    }

    pub(crate) fn close(&mut self, cx: &mut Context<Self>) {
        if self.open {
            self.open = false;
            self.changed = Some(cx.background_executor().now());
            cx.notify();
        }
    }

    /// How far the dialog is open (0..1) and whether it is still animating.
    pub(crate) fn amount(&self, now: Instant) -> (f32, bool) {
        let settled = if self.open { 1. } else { 0. };
        let Some(at) = self.changed else {
            return (settled, false);
        };
        let p = now.saturating_duration_since(at).as_secs_f32() / OPEN.as_secs_f32();
        if p >= 1. {
            return (settled, false);
        }
        let v = if self.open {
            cubic_bezier(0.2, 0.8, 0.2, 1.)(p)
        } else {
            1. - cubic_bezier(0.4, 0., 1., 1.)(p)
        };
        (v, true)
    }

    fn activate(&mut self, key: &str, cx: &mut Context<Self>) {
        let known = self
            .spec
            .leading
            .iter()
            .chain(&self.spec.trailing)
            .map(|(k, _)| *k);
        let known = known.chain(self.spec.actions.iter().map(|(k, _, _)| *k));
        if let Some(key) = known.into_iter().find(|k| *k == key) {
            cx.emit(Activated(key));
        }
    }

    /// Enter in the dialog's field activates its primary button.
    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if let Some((key, _, _)) = self.spec.actions.iter().find(|(_, _, primary)| *primary) {
            cx.emit(Activated(key));
        }
    }

    /// Ends a press on mouse up anywhere and tracks the pointer while one is held (a click
    /// whose down and up land before the next frame still activates).
    fn pointer_layer(cx: &mut Context<Self>) -> AnyElement {
        let this = cx.entity().downgrade();
        canvas(
            |_, _, _| (),
            move |_, (), window, _| {
                let (m, u) = (this.clone(), this.clone());
                window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = m.update(cx, |this, cx| {
                            if this
                                .presses
                                .moved(e.position, cx.background_executor().now())
                            {
                                cx.notify();
                            }
                        });
                    }
                });
                window.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture && e.button == MouseButton::Left {
                        let _ = u.update(cx, |this, cx| {
                            let now = cx.background_executor().now();
                            if let Some(key) = this.presses.end(e.position, now) {
                                this.activate(&key, cx);
                            }
                            cx.notify();
                        });
                    }
                });
            },
        )
        .absolute()
        .size_0()
        .into_any_element()
    }

    fn header(&mut self, s: f32, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let z = |x: f32| px(x * s);
        let leading = self
            .spec
            .leading
            .map(|(k, g)| self.round_button(k, g, BUTTON * s, cx));
        let trailing: Vec<_> = (self.spec.trailing.clone().into_iter())
            .map(|(k, g)| self.round_button(k, g, BUTTON * s, cx))
            .collect();
        div()
            .absolute()
            .left(z(14.))
            .right(z(14.))
            .top(z(14.))
            .flex()
            .justify_between()
            .child(div().children(leading))
            .child(div().flex().gap(z(8.)).children(trailing))
    }
}

impl Render for Dialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = self.theme.clone();
        let now = cx.background_executor().now();
        let (v, moving) = self.amount(now);
        if moving || self.presses.animating(now) {
            window.request_animation_frame();
        }
        let s = 0.94 + 0.06 * v;
        let z = |x: f32| px(x * s);
        let title = div()
            .absolute()
            .left_0()
            .right_0()
            .top(z(14.))
            .h(z(BUTTON))
            .flex()
            .items_center()
            .justify_center()
            .child(text(
                self.spec.title.clone(),
                (17. * s, 24. * s),
                FontWeight::SEMIBOLD,
                t.text,
            ));
        let header = self.header(s, cx);
        let body = div()
            .absolute()
            .left(z(24.))
            .right(z(24.))
            .top(z(74.))
            .child((self.spec.body)(&t, s));
        let footer = self.footer(s, cx);
        div()
            .id("dialog")
            .occlude()
            .on_action(cx.listener(Self::submit))
            .size_full()
            .relative()
            .opacity(v)
            .child(glass::layer(&t, RADIUS * s, Native::over_content()))
            .child(title)
            .child(header)
            .child(body)
            .child(footer)
            .child(Self::pointer_layer(cx))
    }
}
