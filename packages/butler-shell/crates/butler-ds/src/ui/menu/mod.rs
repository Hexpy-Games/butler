//! The menu core DropdownMenu and ContextMenu share (Radix `Menu`): the open state, the layer
//! (lifecycle, focus scope, dismissal, placement and motion), and, through [`surface`], the
//! rows with their roving highlight, typeahead and submenus. A menu is described by [`Entry`]
//! values; the owner (DropdownMenu, ContextMenu) adds its trigger and defaults.
mod entry;
mod keys;
mod level;
mod rows;
mod runtime;
mod surface;
mod trigger;

use std::rc::Rc;

use gpui::{
    AnyElement, App, Entity, FocusHandle, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div,
};

pub use entry::{CheckboxItem, Checked, Entry, Group, Item, RadioGroup, RadioItem, Sub, Variant};
pub(crate) use rows::{frame as item_frame, indicator_slot, separator};
pub(crate) use trigger::TriggerBox;

use level::Level;
use runtime::{Runtime, first_enabled};

use crate::tokens::Duration as DsDuration;
use crate::ui::context::Ds;
use crate::ui::layer::Z;
use crate::ui::overlay::dismiss::{Dismissable, Handle, Reason};
use crate::ui::overlay::lifecycle::{Lifecycle, Phase, Spec as LifeSpec};
use crate::ui::overlay::place::{Align, Options, Side};
use crate::ui::overlay::popper::{Anchor, Output, Popper};
use crate::ui::overlay::scope::Scope;
use crate::ui::overlay::theme::Theme;
use crate::ui::overlay::{motion, scrim};

type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// The measured reference rectangle and the resolved position, kept across frames.
#[derive(Clone, Default)]
pub(crate) struct Parts {
    pub reference: Anchor,
    pub output: Output,
}

/// How an owner places and treats its menu.
pub(crate) struct Spec {
    pub side: Side,
    pub align: Align,
    pub side_offset: f32,
    /// Scroll lock, blocked outside pointer events and trapped focus (ContextMenu).
    pub modal: bool,
    /// The surface is no taller than the room Radix measured, and scrolls (DropdownMenu).
    pub cap_height: bool,
    pub theme: Option<Theme>,
    /// The trigger's focus handle: focus on it is not outside.
    pub trigger_focus: Option<FocusHandle>,
}

/// An open menu's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub(crate) struct Menu {
    pub(crate) id: SharedString,
    open: Entity<bool>,
    life: Entity<Lifecycle>,
    scope: Entity<Scope>,
    rt: Entity<Runtime>,
    pub(crate) parts: Parts,
    /// Set from the owner's [`Spec`] when the layer is built: focus is trapped and does not
    /// dismiss.
    modal: bool,
    controlled: Option<bool>,
    on_open_change: Option<OpenChange>,
    theme: Theme,
}

impl Menu {
    pub(crate) fn new(id: impl Into<SharedString>, window: &mut Window, cx: &mut App) -> Self {
        let id: SharedString = id.into();
        let key: gpui::ElementId = id.clone().into();
        let parts = window
            .use_keyed_state((key.clone(), "parts"), cx, |_, _| Parts::default())
            .read(cx)
            .clone();
        Self {
            open: window.use_keyed_state((key.clone(), "open"), cx, |_, _| false),
            life: window.use_keyed_state((key.clone(), "life"), cx, |_, _| Lifecycle::default()),
            scope: window.use_keyed_state((key.clone(), "scope"), cx, |_, cx| Scope::new(cx)),
            rt: window.use_keyed_state((key, "runtime"), cx, |_, _| Runtime::default()),
            id,
            parts,
            modal: false,
            controlled: None,
            on_open_change: None,
            theme: Theme::current(cx),
        }
    }

    pub(crate) fn controlled(mut self, open: bool) -> Self {
        self.controlled = Some(open);
        self
    }

    pub(crate) fn on_open_change(mut self, handler: Option<OpenChange>) -> Self {
        self.on_open_change = handler;
        self
    }

    pub(crate) fn is_open(&self, cx: &App) -> bool {
        self.controlled.unwrap_or_else(|| *self.open.read(cx))
    }

    pub(crate) fn set_open(&self, open: bool, window: &mut Window, cx: &mut App) {
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

    /// Opens the menu; a keyboard open highlights the first item.
    pub(crate) fn open_with(&self, keyboard: bool, window: &mut Window, cx: &mut App) {
        self.rt.update(cx, |rt, _| rt.keyboard = keyboard);
        self.set_open(true, window, cx);
    }

    pub(crate) fn close(&self, window: &mut Window, cx: &mut App) {
        self.set_open(false, window, cx);
    }

    /// A pointer down or focus outside closed the menu: focus stays where it went.
    fn dismiss(&self, reason: Reason, window: &mut Window, cx: &mut App) {
        // A modal menu keeps focus: focus moving outside does not close it (Radix prevents it).
        if self.modal && reason == Reason::FocusOutside {
            return;
        }
        if reason != Reason::Escape {
            self.rt.update(cx, |rt, _| rt.outside = true);
        }
        self.close(window, cx);
    }

    /// The layer: the surface (and, modal, the scrim under it) while open and during the exit.
    pub(crate) fn content(
        &self,
        spec: &Spec,
        entries: Vec<Entry>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let exit = Ds::get(cx).duration(DsDuration::MotionExitMenu);
        let open = self.is_open(cx);
        let root = Rc::new(Level::flatten(entries));
        let first = first_enabled(&root);
        self.rt.update(cx, |rt, _| rt.begin(open, first));
        let life = LifeSpec {
            modal: spec.modal,
            parent: None,
        };
        let synced = Lifecycle::sync(
            &self.life,
            open,
            &life,
            &self.parts.output,
            exit,
            window,
            cx,
        );
        let restore = !self.rt.read(cx).outside;
        self.scope.update(cx, |scope, cx| {
            scope.sync(open, true, restore, window, cx);
        });
        if synced.phase == Phase::Closed {
            return footprint(div());
        }
        let this = Self {
            modal: spec.modal,
            ..self.clone()
        };
        let layer = this.layer(spec, &root, synced.phase, synced.handle, window, cx);
        let under = spec.modal.then(|| scrim(Z::Popover, window));
        footprint(div().children(under).child(layer))
    }

    fn layer(
        &self,
        spec: &Spec,
        root: &Rc<Level>,
        phase: Phase,
        handle: Option<Handle>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let theme = spec.theme.unwrap_or(self.theme);
        let focus = self.scope.read(cx).handle.clone();
        let shown = self.parts.output.get();
        let options = Options {
            side: spec.side,
            align: spec.align,
            side_offset: spec.side_offset,
            padding: surface::collision_padding(Ds::get(cx)),
            avoid_collisions: true,
        };
        let frozen = match phase {
            Phase::Exiting { frozen, .. } => frozen,
            _ => None,
        };
        let env = Env {
            menu: self.clone(),
            rt: self.rt.clone(),
            id: self.id.clone(),
        };
        let cap = spec.cap_height.then(|| shown.map(|r| r.available_height));
        let content = theme.scoped(cx, |cx| {
            surface::root(
                &env,
                root,
                cap.flatten(),
                handle.as_ref(),
                &focus,
                window,
                cx,
            )
        });
        let ds = Ds::get(cx);
        let side = shown.map_or(spec.side, |resolved| resolved.side);
        let animated = motion::animate(
            &format!("{}-menu", self.id),
            phase,
            side,
            motion::Motion::MENU,
            content,
            ds,
        );
        let Some(animated) = animated else {
            return div().into_any_element();
        };
        let child = match handle {
            Some(handle) => {
                let menu = self.clone();
                let layer = Dismissable::new(handle, animated, move |reason, window, cx| {
                    menu.dismiss(reason, window, cx);
                })
                .focus(&focus);
                let layer = if spec.modal {
                    layer
                } else {
                    layer.ignore(self.parts.reference.cell(), spec.trigger_focus.as_ref())
                };
                layer.into_any_element()
            }
            None => animated,
        };
        Popper::new(
            Z::Popover,
            &self.parts.reference,
            options,
            &self.parts.output,
            theme,
            child,
        )
        .frozen(frozen)
        .into_any_element()
    }
}

/// What a row and its handlers need of the menu: the menu itself, its runtime and its id.
#[derive(Clone)]
struct Env {
    menu: Menu,
    rt: Entity<Runtime>,
    id: SharedString,
}

/// The layer takes no room in the layout around it (Radix portals the surface out of it).
pub(crate) fn footprint(child: impl gpui::IntoElement) -> AnyElement {
    div().absolute().size_0().child(child).into_any_element()
}
