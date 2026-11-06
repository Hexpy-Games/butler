//! DS BottomSheet (BottomSheet.tsx over Radix Dialog): a modal sheet along the bottom edge for
//! choices and short tasks on phones, and the sheet presentation of Popover, DropdownMenu and
//! Select ([`present`]). The grabber row drags the sheet: it follows the pointer down, resists
//! upward past the top, and a release dismisses it (past 30% of its height, or a flick faster
//! than 0.5 px/ms), changes the detent of an expandable sheet (48px, or a flick) or springs
//! back on the settle curve. Escape and a pointer down on the backdrop close it; focus moves in
//! and returns to the opener, and Tab wraps inside. Above an on-screen keyboard the sheet lifts
//! by the inset the app feeds in with `Ds::set_keyboard_inset`.
mod anim;
mod drag;
mod handle;
mod item;
pub mod present;
mod state;
mod surface;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, IntoElement as _, ParentElement as _, SharedString, Window,
    div,
};

pub use handle::SheetHandle;
use item::Close;
pub use item::{BottomSheetItem, SelectEvent, Variant};
pub use state::SheetState;
pub use surface::body;
pub(crate) use surface::shrinking;

use crate::tokens::Duration as DsDuration;
use crate::ui::context::Ds;
use crate::ui::overlay::dismiss::Reason;
use crate::ui::overlay::lifecycle::{Lifecycle, Phase, Spec};
use crate::ui::overlay::popper::Output;
use crate::ui::overlay::scope::Scope;
use crate::ui::overlay::theme::Theme;
use present::Presented;

type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// What a sheet shows.
pub struct SheetContent {
    title: SharedString,
    close_label: SharedString,
    expandable: bool,
    theme: Option<Theme>,
    items: Vec<BottomSheetItem>,
}

impl SheetContent {
    /// `title` is the visible heading and the sheet's name; `close_label` names the grabber,
    /// which closes the sheet.
    pub fn new(title: impl Into<SharedString>, close_label: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            close_label: close_label.into(),
            expandable: false,
            theme: None,
            items: Vec::new(),
        }
    }

    /// Rests at half height and drags up to full height (long lists, forms).
    pub fn expandable(mut self) -> Self {
        self.expandable = true;
        self
    }

    /// The theme of the portalled surface; by default the one the sheet was built in.
    pub fn theme(mut self, theme: Theme) -> Self {
        self.theme = Some(theme);
        self
    }

    pub fn item(mut self, item: BottomSheetItem) -> Self {
        self.items.push(item);
        self
    }
}

/// An open sheet's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub struct BottomSheet {
    id: ElementId,
    open: Entity<bool>,
    life: Entity<Lifecycle>,
    scope: Entity<Scope>,
    state: Entity<SheetState>,
    controlled: Option<bool>,
    on_open_change: Option<OpenChange>,
    theme: Theme,
}

impl BottomSheet {
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        let id = id.into();
        Self {
            open: window.use_keyed_state((id.clone(), "open"), cx, |_, _| false),
            life: window.use_keyed_state((id.clone(), "life"), cx, |_, _| Lifecycle::default()),
            scope: window.use_keyed_state((id.clone(), "scope"), cx, |_, cx| Scope::new(cx)),
            state: window.use_keyed_state((id.clone(), "sheet"), cx, |_, _| SheetState::default()),
            id,
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

    /// The sheet and its backdrop, in the top layer while open and during their exit.
    pub fn content(&self, content: SheetContent, window: &mut Window, cx: &mut App) -> AnyElement {
        let exit = Ds::get(cx).duration(DsDuration::MotionExitSlow);
        let open = self.is_open(cx);
        let spec = Spec {
            modal: true,
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
            return crate::ui::menu::footprint(div());
        }
        // Radix: focus moves in on open (the grabber, the first tabbable) and back on close.
        self.scope
            .update(cx, |scope, cx| scope.sync(open, false, true, window, cx));
        if let Phase::Open { key } = synced.phase {
            Scope::enter_when_drawn(&self.scope, &self.id, key, window, cx);
        }
        crate::ui::menu::footprint(self.layers(content, synced.phase, synced.handle, window, cx))
    }

    fn layers(
        &self,
        content: SheetContent,
        phase: Phase,
        handle: Option<crate::ui::overlay::dismiss::Handle>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        self.state.update(cx, |state, _| {
            state.set_expandable(content.expandable);
        });
        let this = self.clone();
        let close: Close = Rc::new(move |window, cx| this.set_open(false, window, cx));
        let ds = Ds::get(cx);
        let grabber = SheetHandle::new((self.id.clone(), "handle"), &self.state, {
            let close = close.clone();
            move |window, cx| close(window, cx)
        })
        .close_label(content.close_label)
        .into_any_element();
        let items = content
            .items
            .into_iter()
            .map(|item| item.closing(close.clone()));
        let scroll = body((self.id.clone(), "body"), None, ds).children(items);
        let this = self.clone();
        let expanded = self.state.read(cx).expanded();
        Presented {
            id: SharedString::from(format!("{}", self.id)),
            phase,
            handle,
            theme: content.theme.unwrap_or(self.theme),
            state: self.state.clone(),
            focus: self.scope.read(cx).handle.clone(),
            scope: Some(self.scope.clone()),
            grabber,
            title: Some(content.title),
            expandable: content.expandable.then_some(expanded),
            content: vec![scroll.into_any_element()],
            selector: "sheet-content",
            // A modal sheet keeps focus inside: moving it outside does not close.
            on_dismiss: Rc::new(move |reason, window, cx| {
                if reason != Reason::FocusOutside {
                    this.set_open(false, window, cx);
                }
            }),
        }
        .layers(window, cx)
    }
}
