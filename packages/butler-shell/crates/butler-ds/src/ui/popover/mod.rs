//! DS Popover (shadcn/ui/popover.tsx over Radix Popover): a non-modal surface anchored to its
//! trigger, or to a [`Popover::anchor`]. Pieces compose like Radix's: [`Popover::new`] holds the
//! open state, `trigger`, `anchor` and `content` are placed anywhere in the tree. The trigger
//! toggles it; Escape, a pointer down outside and focus moving outside close it; focus stays on
//! the trigger (the DS prevents auto-focus and restore). At width <= 640px the surface is the
//! attached full-width mobile sheet.
mod content;
mod parts;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, Entity, FocusHandle, InteractiveElement as _,
    IntoElement as _, ParentElement as _, Styled as _, Window, div,
};

pub use content::{Density, MenuSize, PopoverContent, Width};
pub use parts::{PopoverDescription, PopoverHeader, PopoverTitle};

use crate::tokens::Duration as DsDuration;
use crate::ui::bottom_sheet::SheetState;
use crate::ui::bottom_sheet::present::{self, Presented};
use crate::ui::context::Ds;
use crate::ui::layer::Z;
use crate::ui::menu::TriggerBox;
use crate::ui::overlay::Presentation;
use crate::ui::overlay::dismiss::Dismissable;
use crate::ui::overlay::lifecycle::{Lifecycle, Phase, Spec};
use crate::ui::overlay::motion::{self, Motion};
use crate::ui::overlay::place::{Options, Side};
use crate::ui::overlay::popper::{Anchor, Output, Popper};
use crate::ui::overlay::scope::Scope;
use crate::ui::overlay::theme::Theme;

type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// The measured reference rectangles and the resolved position, kept across frames.
#[derive(Clone, Default)]
struct Parts {
    trigger: Anchor,
    anchor: Anchor,
    output: Output,
}

/// An open popover's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub struct Popover {
    id: ElementId,
    open: Entity<bool>,
    life: Entity<Lifecycle>,
    scope: Entity<Scope>,
    sheet: Entity<SheetState>,
    parts: Parts,
    trigger_focus: FocusHandle,
    controlled: Option<bool>,
    on_open_change: Option<OpenChange>,
    theme: Theme,
}

/// Toggles the popover; hand its [`Toggle::on_click`] to the trigger control.
#[derive(Clone)]
pub struct Toggle(Popover);

impl Toggle {
    pub fn on_click(&self) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let popover = self.0.clone();
        move |_, window, cx| {
            let open = popover.is_open(cx);
            popover.set_open(!open, window, cx);
        }
    }
}

impl Popover {
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        let id = id.into();
        let parts = window
            .use_keyed_state((id.clone(), "parts"), cx, |_, _| Parts::default())
            .read(cx)
            .clone();
        let trigger_focus = window
            .use_keyed_state((id.clone(), "trigger-focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        Self {
            open: window.use_keyed_state((id.clone(), "open"), cx, |_, _| false),
            life: window.use_keyed_state((id.clone(), "life"), cx, |_, _| Lifecycle::default()),
            scope: window.use_keyed_state((id.clone(), "scope"), cx, |_, cx| Scope::new(cx)),
            sheet: window.use_keyed_state((id.clone(), "sheet"), cx, |_, _| SheetState::default()),
            id,
            parts,
            trigger_focus,
            controlled: None,
            on_open_change: None,
            theme: Theme::current(cx),
        }
    }

    /// Controlled: the caller owns the open state and hears changes in `on_open_change`.
    pub fn open(mut self, open: bool) -> Self {
        self.controlled = Some(open);
        self
    }

    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open_change = Some(Rc::new(handler));
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

    /// The trigger: `build` makes the control from a [`Toggle`] for its click handler. The
    /// wrapper is as wide as the control, which it decides when it is laid out (a trigger in a
    /// column that stretches its items starts at the container's edge).
    pub fn trigger(&self, build: impl FnOnce(Toggle) -> AnyElement) -> AnyElement {
        self.wrap_trigger(false, build)
    }

    /// A trigger that fills its container's width (a `SelectButton`).
    pub fn trigger_fill(&self, build: impl FnOnce(Toggle) -> AnyElement) -> AnyElement {
        self.wrap_trigger(true, build)
    }

    fn wrap_trigger(&self, fill: bool, build: impl FnOnce(Toggle) -> AnyElement) -> AnyElement {
        let popover = self.clone();
        let wrapper = TriggerBox::new(build(Toggle(self.clone())), move |wrapper| {
            wrapper
                .track_focus(&popover.trigger_focus)
                .tab_stop(false)
                .child(popover.parts.trigger.probe())
        });
        let wrapper = if fill { wrapper.fill() } else { wrapper };
        wrapper.into_any_element()
    }

    /// `PopoverAnchor`: the surface is placed against this element instead of the trigger.
    pub fn anchor(&self, child: impl gpui::IntoElement) -> AnyElement {
        div()
            .relative()
            .child(child)
            .child(self.parts.anchor.probe())
            .into_any_element()
    }

    /// The surface, in the top layer while open and during its exit.
    pub fn content(
        &self,
        content: PopoverContent,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let bottom_sheet = Self::is_bottom_sheet(&content, window);
        let exit = ds.duration(if bottom_sheet {
            DsDuration::MotionExitSlow
        } else {
            DsDuration::MotionExitFast
        });
        let open = self.is_open(cx);
        let synced = Lifecycle::sync(
            &self.life,
            open,
            &Spec::default(),
            &self.parts.output,
            exit,
            window,
            cx,
        );
        if synced.phase == Phase::Closed {
            return footprint(div());
        }
        // A sheet takes focus in and gives it back to the trigger, unlike the anchored popover.
        let auto_focus = content.auto_focus && !bottom_sheet;
        let scope = self.scope.clone();
        scope.update(cx, |scope, cx| {
            scope.sync(open, auto_focus, auto_focus || bottom_sheet, window, cx);
        });
        if let (true, Phase::Open { key }) = (bottom_sheet, synced.phase) {
            Scope::enter_when_drawn(&scope, &self.id, key, window, cx);
        }
        let focus = scope.read(cx).handle.clone();
        if bottom_sheet {
            let layers =
                self.sheet_layers(content, synced.phase, synced.handle, &focus, window, cx);
            return footprint(layers);
        }
        footprint(self.layer(content, synced.phase, synced.handle, &focus, window, cx))
    }
}

/// The layer takes no room in the layout around it (Radix portals the surface out of it).
fn footprint(child: impl gpui::IntoElement) -> AnyElement {
    div().absolute().size_0().child(child).into_any_element()
}

impl Popover {
    /// Whether the content is presented as a BottomSheet in this window: its `presentation`, or
    /// the app default (popover; a field-wide `Width::Anchor` list always stays attached).
    fn is_bottom_sheet(content: &PopoverContent, window: &Window) -> bool {
        let default = if content.width == Width::Anchor {
            Presentation::Popover
        } else {
            Presentation::default()
        };
        let width = f32::from(window.viewport_size().width);
        content.presentation.unwrap_or(default).is_sheet(width)
    }

    /// The BottomSheet presentation: the content in the sheet's body under its backdrop.
    fn sheet_layers(
        &self,
        content: PopoverContent,
        phase: Phase,
        handle: Option<crate::ui::overlay::dismiss::Handle>,
        focus: &FocusHandle,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let theme = content.theme.unwrap_or(self.theme);
        let id = gpui::SharedString::from(format!("{}-popover", self.id));
        let scroll = theme.scoped(cx, |cx| {
            crate::ui::bottom_sheet::body((self.id.clone(), "sheet-body"), None, Ds::get(cx))
                .children(content.into_children())
                .into_any_element()
        });
        let popover = self.clone();
        Presented {
            grabber: present::decorative_handle(&id, &self.sheet),
            id,
            phase,
            handle,
            theme,
            state: self.sheet.clone(),
            focus: focus.clone(),
            scope: Some(self.scope.clone()),
            title: None,
            expandable: None,
            content: vec![scroll],
            selector: "popover-content",
            on_dismiss: Rc::new(move |_, window, cx| popover.set_open(false, window, cx)),
        }
        .layers(window, cx)
    }

    /// The reference the surface is placed against: the anchor when there is one, else the trigger.
    fn reference(&self) -> &Anchor {
        if self.parts.anchor.bounds().is_some() {
            &self.parts.anchor
        } else {
            &self.parts.trigger
        }
    }

    fn layer(
        &self,
        content: PopoverContent,
        phase: Phase,
        handle: Option<crate::ui::overlay::dismiss::Handle>,
        focus: &FocusHandle,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let viewport = window.viewport_size();
        let viewport = (f32::from(viewport.width), f32::from(viewport.height));
        let sheet = ds.compact() && content.width != Width::Anchor;
        let side = content::sheet_side(sheet, content.side.unwrap_or(Side::Bottom));
        let reference = self.reference();
        let anchor_width = reference.bounds().map_or(0., |b| f32::from(b.size.width));
        let output = &self.parts.output;
        let frame = content::Context {
            viewport,
            anchor_width,
            resolved: output.get(),
            sheet,
        };
        let options = Options {
            side,
            align: content.align,
            side_offset: content.side_offset,
            padding: content::collision_padding(ds, sheet),
            avoid_collisions: true,
        };
        let theme = content.theme.unwrap_or(self.theme);
        let shown_side = frame.resolved.map_or(side, |resolved| resolved.side);
        let motion_kind = if sheet {
            Motion::POPOVER_SHEET
        } else {
            Motion::POPOVER
        };
        let frozen = match phase {
            Phase::Exiting { frozen, .. } => frozen,
            _ => None,
        };
        let surface = theme.scoped(cx, |cx| content.surface(Ds::get(cx), &frame));
        let ds = Ds::get(cx);
        let animated = motion::animate(
            &format!("{}-popover", self.id),
            phase,
            shown_side,
            motion_kind,
            surface,
            ds,
        );
        let Some(animated) = animated else {
            return div().into_any_element();
        };
        let child = match handle {
            Some(handle) => {
                let popover = self.clone();
                Dismissable::new(handle, animated, move |_, window, cx| {
                    popover.set_open(false, window, cx);
                })
                .focus(focus)
                .ignore(self.parts.trigger.cell(), Some(&self.trigger_focus))
                .into_any_element()
            }
            None => animated,
        };
        let child = div().track_focus(focus).child(child);
        Popper::new(Z::Popover, reference, options, output, theme, child)
            .frozen(frozen)
            .into_any_element()
    }
}
