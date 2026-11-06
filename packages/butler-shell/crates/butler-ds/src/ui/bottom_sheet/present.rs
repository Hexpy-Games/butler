//! The sheet presentation (card section 0.7, `sheet-presentation.css`, `SheetPresentation.tsx`):
//! a Popover, DropdownMenu or Select that opens as a BottomSheet keeps its keyboard, typeahead
//! and dismissal and only changes its placement and chrome. The surface is pinned to the bottom
//! edge, full width, under a fixed backdrop in `--dialog-overlay-bg`; a pointer down on the
//! backdrop is an outside click, which closes the overlay; a dragging dismiss closes it the way
//! Escape does. The BottomSheet itself puts its own grabber, title and detent on the same layers.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, InteractiveElement as _, IntoElement as _,
    ParentElement as _, SharedString, Styled as _, Window, div, px,
};

use super::anim::{self, Frame};
use super::handle::SheetHandle;
use super::state::SheetState;
use super::surface::{Metrics, Surface};
use crate::ui::context::Ds;
use crate::ui::layer::Z;
use crate::ui::overlay::dismiss::{self, Dismissable, Handle, Reason};
use crate::ui::overlay::lifecycle::Phase;
use crate::ui::overlay::popper::Popper;
use crate::ui::overlay::scope::Scope;
use crate::ui::overlay::theme::Theme;

type Dismiss = Rc<dyn Fn(Reason, &mut Window, &mut App)>;

/// The decorative grabber of a presented sheet: a dragging dismiss closes the overlay the way
/// Escape does (`dismissLikeEscape`).
pub fn decorative_handle(id: &SharedString, state: &Entity<SheetState>) -> AnyElement {
    SheetHandle::new(
        (ElementId::from(id.clone()), "handle"),
        state,
        |window, cx| {
            dismiss::escape(window, cx);
        },
    )
    .into_any_element()
}

/// A sheet's layers: an overlay presented as one, or a BottomSheet.
pub struct Presented {
    pub id: SharedString,
    pub phase: Phase,
    /// Its place on the dismiss stack while open.
    pub handle: Option<Handle>,
    pub theme: Theme,
    pub state: Entity<SheetState>,
    /// The focus handle that holds the content (the layer's focus scope).
    pub focus: FocusHandle,
    /// Tab and Shift+Tab wrap inside the sheet (`loopSheetFocus`).
    pub scope: Option<Entity<Scope>>,
    /// The grabber row.
    pub grabber: AnyElement,
    pub title: Option<SharedString>,
    /// `Some(expanded)` for an expandable sheet.
    pub expandable: Option<bool>,
    /// What follows the grabber row (and the title): the scrolling body.
    pub content: Vec<AnyElement>,
    /// The `debug_selector` the overlay's own surface has when anchored.
    pub selector: &'static str,
    pub on_dismiss: Dismiss,
}

impl Presented {
    /// The backdrop and the surface, each in the top layer at `--z-popover`.
    pub fn layers(self, window: &mut Window, cx: &mut App) -> AnyElement {
        let (width, height) = {
            let size = window.viewport_size();
            (f32::from(size.width), f32::from(size.height))
        };
        if let Phase::Open { key } | Phase::Exiting { key, .. } = self.phase {
            self.state.update(cx, |state, _| state.open(key));
        }
        let id = format!("{}-sheet", self.id);
        let backdrop = anim::backdrop(&id, self.phase, (width, height), Ds::get(cx));
        let theme = self.theme;
        let surface = self.surface((width, height), window, cx);
        let backdrop = backdrop.map(|backdrop| Popper::pinned(Z::Popover, theme, backdrop));
        div()
            .children(backdrop)
            .children(surface.map(|surface| Popper::pinned(Z::Popover, theme, surface)))
            .into_any_element()
    }

    /// The surface, animated, guarded by the dismiss stack and pinned to the bottom edge of a
    /// window-sized box.
    fn surface(
        self,
        window_size: (f32, f32),
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let ds = Ds::get(cx);
        let metrics = Metrics::new(window_size, ds);
        let built = Surface {
            handle: self.grabber,
            title: self.title,
            content: self.content,
            expandable: self.expandable,
            selector: self.selector,
        }
        .build(self.state.read(cx), metrics, ds);
        let frame = Frame {
            state: self.state.clone(),
            window_height: window_size.1,
        };
        let animated = anim::animate(
            &format!("{}-sheet", self.id),
            self.phase,
            &frame,
            built,
            window,
            cx,
        )?;
        let guarded = match self.handle {
            Some(handle) => {
                let on_dismiss = self.on_dismiss;
                Dismissable::new(handle, animated, move |reason, window, cx| {
                    on_dismiss(reason, window, cx);
                })
                .focus(&self.focus)
                .into_any_element()
            }
            None => animated,
        };
        let mut content = div().track_focus(&self.focus).child(guarded);
        if let Some(scope) = self.scope {
            content = content.capture_key_down(move |event, window, cx| {
                if event.keystroke.key == "tab"
                    && scope.update(cx, |scope, cx| {
                        scope.trap_tab(event.keystroke.modifiers.shift, window, cx)
                    })
                {
                    cx.stop_propagation();
                }
            });
        }
        Some(
            div()
                .w(px(window_size.0))
                .h(px(window_size.1))
                .flex()
                .flex_col()
                .justify_end()
                .child(content)
                .into_any_element(),
        )
    }
}

/// Runs `build` with touch-sized rows, as inside a sheet (`--menu-item-height: 44px`).
pub fn rows<R>(cx: &mut App, build: impl FnOnce(&mut App) -> R) -> R {
    Ds::update(cx, |ds| ds.set_sheet_rows(true));
    let built = build(cx);
    Ds::update(cx, |ds| ds.set_sheet_rows(false));
    built
}
