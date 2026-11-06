//! DS Toast (Toaster.tsx + Toast.module.css over sonner 2.0.7): the one toast region of the app,
//! a stack at the top centre. [`show`] raises a toast from anywhere, [`dismiss`] takes one away,
//! and a single [`Toaster`] in the window's root draws them. sonner's rules are kept: a 4s
//! lifetime (a loading toast stays until it is updated or dismissed), the three newest visible,
//! the stack collapsed (each toast behind the front one smaller by 5% and a gap lower, its
//! content hidden) and expanded, with every timer paused, while the pointer is over it or alt+T
//! was pressed, and a swipe up past 45px dismisses. The scale of a collapsed toast is gpui's
//! element scale about its centre (see [`layout`]).
mod assets;
mod layout;
mod stack;
mod state;
mod view;

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    App, Div, InteractiveElement as _, IntoElement, Pixels, RenderOnce, SharedString, Window, div,
    point, px,
};

pub(crate) use assets::FILES as ASSETS;
use state::State;

use crate::ui::context::Ds;
use crate::ui::layer::{Layer, Z};

/// Which toast it is (sonner's `id`), to update or dismiss it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToastId(u64);

/// `toast()`, `toast.success`, `.error`, `.warning` and `.loading`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Message,
    Success,
    Error,
    Warning,
    Loading,
}

/// A button on a toast (`action`, `cancel`): `on_click` runs, then the toast goes.
#[derive(Clone)]
pub struct Action {
    label: SharedString,
    on_click: Rc<dyn Fn(&mut App)>,
}

impl Action {
    pub fn new(label: impl Into<SharedString>, on_click: impl Fn(&mut App) + 'static) -> Self {
        Self {
            label: label.into(),
            on_click: Rc::new(on_click),
        }
    }
}

#[derive(Clone)]
pub struct Toast {
    kind: Kind,
    title: SharedString,
    id: Option<ToastId>,
    duration: Option<Duration>,
    action: Option<Action>,
    cancel: Option<Action>,
}

impl Toast {
    fn of(kind: Kind, title: impl Into<SharedString>) -> Self {
        Self {
            kind,
            title: title.into(),
            id: None,
            duration: None,
            action: None,
            cancel: None,
        }
    }

    pub fn message(title: impl Into<SharedString>) -> Self {
        Self::of(Kind::Message, title)
    }

    pub fn success(title: impl Into<SharedString>) -> Self {
        Self::of(Kind::Success, title)
    }

    pub fn error(title: impl Into<SharedString>) -> Self {
        Self::of(Kind::Error, title)
    }

    pub fn warning(title: impl Into<SharedString>) -> Self {
        Self::of(Kind::Warning, title)
    }

    /// Stays until it is updated (by [`Toast::id`]) or dismissed.
    pub fn loading(title: impl Into<SharedString>) -> Self {
        Self::of(Kind::Loading, title)
    }

    /// Shows in place of the toast `id` when there is one (`toast.success(msg, { id })`).
    pub fn id(mut self, id: ToastId) -> Self {
        self.id = Some(id);
        self
    }

    pub fn duration(mut self, duration: Duration) -> Self {
        self.duration = Some(duration);
        self
    }

    pub fn action(mut self, action: Action) -> Self {
        self.action = Some(action);
        self
    }

    pub fn cancel(mut self, cancel: Action) -> Self {
        self.cancel = Some(cancel);
        self
    }
}

/// The one store of the app's toasts.
#[derive(Clone, Default)]
struct Store(Rc<RefCell<State>>);

impl gpui::Global for Store {}

impl Store {
    fn of(cx: &mut App) -> Self {
        if cx.try_global::<Self>().is_none() {
            cx.set_global(Self::default());
        }
        cx.global::<Self>().clone()
    }

    fn dismiss(&self, id: u64, cx: &App) {
        let now = cx.background_executor().now();
        self.0.borrow_mut().dismiss(id, now, false);
    }

    fn begin_swipe(&self, id: u64, at: gpui::Point<Pixels>, now: std::time::Instant, _: &App) {
        self.0.borrow_mut().begin_swipe(id, at, now);
    }
}

/// Raises a toast (`toast.*`); a toast with an existing id replaces that one. Returns its id.
pub fn show(cx: &mut App, toast: Toast) -> ToastId {
    let id = Store::of(cx).0.borrow_mut().show(toast);
    cx.refresh_windows();
    ToastId(id)
}

/// `toast.dismiss(id)`.
pub fn dismiss(cx: &mut App, id: ToastId) {
    Store::of(cx).dismiss(id.0, cx);
    cx.refresh_windows();
}

/// Drops every toast and forgets the stack's state (a new window starts with none).
pub fn reset(cx: &mut App) {
    cx.set_global(Store::default());
}

/// How many toasts are mounted (a leaving one counts until it unmounts).
pub fn mounted(cx: &App) -> usize {
    cx.try_global::<Store>()
        .map_or(0, |store| store.0.borrow().items.len())
}

/// Add to the window's root once: alt+T expands the stack, and Escape then collapses it
/// (sonner's hotkey).
pub fn track(root: Div) -> Div {
    root.capture_key_down(|event, window, cx| {
        let Some(store) = cx.try_global::<Store>().cloned() else {
            return;
        };
        let key = event.keystroke.key.as_str();
        let mut state = store.0.borrow_mut();
        if event.keystroke.modifiers.alt && key == "t" && !state.items.is_empty() {
            state.expanded = true;
            state.hotkey = true;
        } else if key == "escape" && state.hotkey {
            state.expanded = false;
            state.hotkey = false;
        } else {
            return;
        }
        window.refresh();
    })
}

/// The toast region: place one at the end of the window's root element.
#[derive(IntoElement, Default)]
pub struct Toaster {
    offset: Option<Pixels>,
}

impl Toaster {
    pub fn new() -> Self {
        Self::default()
    }

    /// The distance from the window's top edge (the app passes the titlebar safe area); sonner's
    /// 24px, or 16px on a phone, by default.
    pub fn offset(mut self, offset: Pixels) -> Self {
        self.offset = Some(offset);
        self
    }
}

/// sonner's width and its phone breakpoint.
const WIDTH: f32 = 356.; // DS: sonner TOAST_WIDTH
const PHONE: f32 = 600.; // DS: sonner styles.css `@media (max-width: 600px)`
const OFFSET: f32 = 24.; // DS: sonner VIEWPORT_OFFSET
const PHONE_OFFSET: f32 = 16.; // DS: sonner MOBILE_VIEWPORT_OFFSET

impl RenderOnce for Toaster {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let store = Store::of(cx);
        let now = cx.background_executor().now();
        store.0.borrow_mut().tick(now);
        if store.0.borrow().items.is_empty() {
            return div().into_any_element();
        }
        let vw = f32::from(window.viewport_size().width);
        let phone = vw <= PHONE;
        let (left, width) = if phone {
            (PHONE_OFFSET, vw - 2. * PHONE_OFFSET)
        } else {
            ((vw - WIDTH) / 2., WIDTH)
        };
        let top = self
            .offset
            .unwrap_or_else(|| px(if phone { PHONE_OFFSET } else { OFFSET }));
        let stack = stack::build(&store, width, now, Ds::get(cx), window);
        stack::schedule(&store, now, window, cx);
        Layer::new(Z::Drag, point(px(left), top), stack).into_any_element()
    }
}
