//! DS Dialog (shadcn/ui/dialog.tsx over Radix Dialog): a glass surface centred in the window, or
//! anchored in a card, over a scrim. Pieces compose like Radix's: [`Dialog::new`] holds the open
//! state, [`Dialog::trigger`] and [`Dialog::content`] are placed anywhere in the tree, and
//! [`Dialog::closer`] gives any control the close action (`DialogClose asChild`).
//!
//! Modal (the default): the scrim blocks and dims the page and locks its scrolling, focus moves
//! into the dialog on open, Tab stays inside it, and focus goes back to where it was on close.
//! Escape and a pointer down on the scrim close it. Non-modal: no scrim of its own (a contained
//! dialog's covers its card), no trap. `dialog-enter` and `dialog-exit` fade the surface, travel it
//! and scale it by `--motion-scale-dialog` about its centre.
mod content;
mod parts;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, FocusHandle, InteractiveElement as _,
    IntoElement as _, ParentElement as _, Pixels, ScrollHandle, Styled as _, Window, div, point,
    px,
};

pub use content::{DialogContent, Layout, MaxHeight, Motion, Size};
pub use parts::{DialogDescription, DialogFooter, DialogHeader, DialogTitle};

use crate::tokens::{Color, Duration as DsDuration, Length};
use crate::ui::context::Ds;
use crate::ui::layer::{Layer, Z};
use crate::ui::menu::TriggerBox;
use crate::ui::motion::{Timing, Tween};
use crate::ui::overlay::dismiss::{Dismissable, Handle, Reason};
use crate::ui::overlay::lifecycle::{Lifecycle, Phase, Spec};
use crate::ui::overlay::motion::{self, Motion as Keyframes};
use crate::ui::overlay::place::Side;
use crate::ui::overlay::popper::{Anchor, Output};
use crate::ui::overlay::scope::Scope;

type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// An open dialog's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub struct Dialog {
    id: ElementId,
    open: Entity<bool>,
    life: Entity<Lifecycle>,
    scope: Entity<Scope>,
    trigger: Anchor,
    card: Anchor,
    scroll: ScrollHandle,
    grab: Entity<Option<f32>>,
    trigger_focus: FocusHandle,
    controlled: Option<bool>,
    on_open_change: Option<OpenChange>,
    modal: bool,
}

/// Toggles the dialog; hand its [`Toggle::on_click`] to the trigger control.
#[derive(Clone)]
pub struct Toggle(Dialog);

impl Toggle {
    pub fn on_click(&self) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let dialog = self.0.clone();
        move |_, window, cx| {
            let open = dialog.is_open(cx);
            dialog.set_open(!open, window, cx);
        }
    }
}

/// Closes the dialog (`DialogClose`): hand [`Close::on_click`] to a Button.
#[derive(Clone)]
pub struct Close(Dialog);

impl Close {
    pub fn on_click(&self) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let dialog = self.0.clone();
        move |_, window, cx| dialog.set_open(false, window, cx)
    }
}

impl Dialog {
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        let id = id.into();
        let anchor = |window: &mut Window, cx: &mut App, name: &'static str| {
            window
                .use_keyed_state((id.clone(), name), cx, |_, _| Anchor::default())
                .read(cx)
                .clone()
        };
        let trigger = anchor(window, cx, "trigger");
        let card = anchor(window, cx, "card");
        let keyed = |window: &mut Window, cx: &mut App, name: &'static str| {
            window
                .use_keyed_state((id.clone(), name), cx, |_, _| ScrollHandle::new())
                .read(cx)
                .clone()
        };
        let scroll = keyed(window, cx, "scroll");
        let trigger_focus = window
            .use_keyed_state((id.clone(), "trigger-focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        Self {
            open: window.use_keyed_state((id.clone(), "open"), cx, |_, _| false),
            life: window.use_keyed_state((id.clone(), "life"), cx, |_, _| Lifecycle::default()),
            scope: window.use_keyed_state((id.clone(), "scope"), cx, |_, cx| Scope::new(cx)),
            grab: window.use_keyed_state((id.clone(), "grab"), cx, |_, _| None),
            id,
            trigger,
            card,
            scroll,
            trigger_focus,
            controlled: None,
            on_open_change: None,
            modal: true,
        }
    }

    /// Controlled: the caller owns the open state and hears changes in `on_open_change`.
    pub fn open(mut self, open: bool) -> Self {
        self.controlled = Some(open);
        self
    }

    /// Uncontrolled and open from the start (`defaultOpen`).
    pub fn default_open(self, window: &mut Window, cx: &mut App) -> Self {
        let started = window.use_keyed_state((self.id.clone(), "started"), cx, |_, _| false);
        if !*started.read(cx) {
            started.update(cx, |started, _| *started = true);
            self.open.update(cx, |open, _| *open = true);
        }
        self
    }

    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open_change = Some(Rc::new(handler));
        self
    }

    /// `modal` (default true): scrim, scroll lock and a focus trap.
    pub fn modal(mut self, modal: bool) -> Self {
        self.modal = modal;
        self
    }

    pub fn is_open(&self, cx: &App) -> bool {
        self.controlled.unwrap_or_else(|| *self.open.read(cx))
    }

    pub fn set_open(&self, open: bool, window: &mut Window, cx: &mut App) {
        if self.controlled.is_none() {
            self.open.update(cx, |state, cx| {
                *state = open;
                cx.notify();
            });
        }
        if let Some(handler) = &self.on_open_change {
            handler(open, window, cx);
        }
        window.refresh();
    }

    /// The trigger: `build` makes the control from a [`Toggle`] for its click handler.
    pub fn trigger(&self, build: impl FnOnce(Toggle) -> AnyElement) -> AnyElement {
        let dialog = self.clone();
        TriggerBox::new(build(Toggle(self.clone())), move |wrapper| {
            wrapper
                .track_focus(&dialog.trigger_focus)
                .tab_stop(false)
                .child(dialog.trigger.probe())
        })
        .into_any_element()
    }

    pub fn closer(&self) -> Close {
        Close(self.clone())
    }

    /// Measures the card a [`DialogContent::contained`] dialog is anchored in: put it inside the
    /// card, which must be positioned.
    pub fn container_probe(&self) -> gpui::Div {
        self.card.probe()
    }

    /// The surface and its scrim, in the top layer while open and during their exit.
    pub fn content(&self, content: DialogContent, window: &mut Window, cx: &mut App) -> AnyElement {
        let exit = Ds::get(cx).duration(DsDuration::MotionExitFast);
        let open = self.is_open(cx);
        let spec = Spec {
            modal: self.modal,
            parent: None,
        };
        let synced = Lifecycle::sync(
            &self.life,
            open,
            &spec,
            &Output::default(),
            exit,
            window,
            cx,
        );
        if synced.phase == Phase::Closed {
            return footprint(div());
        }
        // Radix: the first tabbable of the content on open, the trigger again on close. The tab
        // stops are those of the last frame, so focus goes in once the content has been drawn.
        self.scope
            .update(cx, |scope, cx| scope.sync(open, false, true, window, cx));
        if let Phase::Open { key } = synced.phase {
            Scope::enter_when_drawn(&self.scope, &self.id, key, window, cx);
        }
        let focus = self.scope.read(cx).handle.clone();
        let contained = content.contained.is_some();
        let layers = self.layers(content, synced.phase, synced.handle, &focus, window, cx);
        // A card's dialog is part of the card (clipped by it, scrolling with the page).
        if contained { layers } else { footprint(layers) }
    }
}

/// The layers take no room in the layout around them (Radix portals them out of it).
fn footprint(child: impl gpui::IntoElement) -> AnyElement {
    div().absolute().size_0().child(child).into_any_element()
}

/// Where the dialog is placed: the window, or the card it is anchored in.
struct Area {
    origin: gpui::Point<Pixels>,
    size: (f32, f32),
    /// The card's inner corner radius.
    card: Option<Pixels>,
}

impl Dialog {
    fn area(&self, content: &DialogContent, window: &Window) -> Option<Area> {
        let Some(radius) = content.contained else {
            let size = window.viewport_size();
            return Some(Area {
                origin: point(px(0.), px(0.)),
                size: (f32::from(size.width), f32::from(size.height)),
                card: None,
            });
        };
        self.card.bounds().map(|bounds| Area {
            origin: bounds.origin,
            size: content::area_of(bounds),
            card: Some(radius),
        })
    }

    fn layers(
        &self,
        content: DialogContent,
        phase: Phase,
        handle: Option<Handle>,
        focus: &FocusHandle,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        // A card is measured by the frame before this one.
        let Some(area) = self.area(&content, window) else {
            window.request_animation_frame();
            return div().into_any_element();
        };
        let ds = Ds::get(cx);
        let geo = content.geometry(ds, area.size, area.card.is_some());
        let this = self.clone();
        let env = content::Env {
            close: Rc::new(move |window, cx| this.set_open(false, window, cx)),
            scroll: self.scroll.clone(),
            grab: self.grab.clone(),
        };
        let (keyframes, side) = match (content.motion, geo.top_sheet) {
            (Motion::Dialog, _) => (Keyframes::DIALOG, Side::Top),
            (Motion::Palette, false) => (Keyframes::PALETTE, Side::Top),
            (Motion::Palette, true) => (Keyframes::PALETTE_SHEET, Side::Bottom),
        };
        let scrim_motion = if content.motion == Motion::Palette {
            Keyframes::PALETTE
        } else {
            Keyframes::DIALOG
        };
        let id = format!("{}-dialog", self.id);
        let scrim = (self.modal || area.card.is_some())
            .then(|| self.scrim(&id, phase, scrim_motion, &area, ds));
        let surface = content.surface(ds, &geo, &env);
        let Some(animated) = motion::animate(&id, phase, side, (0.5, 0.5), keyframes, surface, ds)
        else {
            return div().into_any_element();
        };
        let child = self.guarded(animated, handle, focus, area.card.is_some());
        let top = ds.len(Length::Space2xl);
        if area.card.is_some() {
            return div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .children(scrim)
                .child(
                    div()
                        .absolute()
                        .top(top)
                        .left(px((area.size.0 - geo.width) / 2.))
                        .child(child),
                )
                .into_any_element();
        }
        let window_sized = div().w(px(area.size.0)).h(px(area.size.1)).flex();
        let window_sized = if geo.top_sheet {
            window_sized
        } else {
            window_sized.items_center()
        };
        let placed = window_sized.justify_center().child(child);
        div()
            .children(scrim.map(|scrim| Layer::new(Z::Overlay, area.origin, scrim)))
            .child(Layer::new(Z::Dialog, area.origin, placed))
            .into_any_element()
    }

    /// The scrim (`--dialog-overlay-bg`) fading with the dialog; a modal one takes every pointer
    /// and wheel event, so the page under it neither receives clicks nor scrolls.
    fn scrim(&self, id: &str, phase: Phase, motion: Keyframes, area: &Area, ds: &Ds) -> AnyElement {
        let mut scrim = div()
            .w(px(area.size.0))
            .h(px(area.size.1))
            .bg(ds.color(Color::DialogOverlayBg));
        if let Some(radius) = area.card {
            // Part of the card: over all of it, rounded like it.
            scrim = scrim.absolute().top_0().left_0().rounded(radius);
        }
        if self.modal || area.card.is_some() {
            scrim = scrim.occlude();
        }
        let (key, enter) = match phase {
            Phase::Open { key } => (key, true),
            Phase::Exiting { key, .. } => (key, false),
            Phase::Closed => return scrim.into_any_element(),
        };
        let timing = if enter {
            Timing::token(ds, motion.enter, motion.enter_ease)
        } else {
            Timing::token(ds, motion.exit, motion.exit_ease)
        };
        Tween::new(
            format!("{id}-scrim-{enter}-{key}"),
            scrim,
            timing,
            move |el, t| el.opacity(if enter { t } else { 1. - t }),
        )
        .into_any_element()
    }

    /// The content in the dismiss stack while open, and in the focus scope: a modal one keeps
    /// Tab inside it. A dialog anchored in a card ignores every outside interaction; a modal one
    /// ignores focus moving outside (the trap keeps it in).
    fn guarded(
        &self,
        animated: AnyElement,
        handle: Option<Handle>,
        focus: &FocusHandle,
        contained: bool,
    ) -> AnyElement {
        let child = match handle {
            Some(handle) => {
                let dialog = self.clone();
                let mut layer = Dismissable::new(handle, animated, move |reason, window, cx| {
                    let ignored = match reason {
                        Reason::Escape => false,
                        Reason::PointerOutside => contained,
                        Reason::FocusOutside => contained || dialog.modal,
                    };
                    if !ignored {
                        dialog.set_open(false, window, cx);
                    }
                })
                .focus(focus);
                if !self.modal {
                    layer = layer.ignore(self.trigger.cell(), Some(&self.trigger_focus));
                }
                layer.into_any_element()
            }
            None => animated,
        };
        let content = div().track_focus(focus).child(child);
        if !self.modal {
            return content.into_any_element();
        }
        let scope = self.scope.clone();
        content
            .capture_key_down(move |event, window, cx| {
                if event.keystroke.key == "tab"
                    && scope.update(cx, |scope, cx| {
                        scope.trap_tab(event.keystroke.modifiers.shift, window, cx)
                    })
                {
                    cx.stop_propagation();
                }
            })
            .into_any_element()
    }
}
