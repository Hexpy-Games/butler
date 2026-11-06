//! The dismissable layer stack (Radix `DismissableLayer`): which overlays are open, in the order
//! they opened, and what dismisses them. Escape closes the topmost layer; a pointer down
//! outside a layer (and outside every layer opened from it) closes it, unless a modal layer sits
//! above; focus moving outside closes it. A [`Guard`] registers a layer and unregisters it when
//! dropped, so a layer that stops rendering leaves the stack with its state.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, FocusHandle, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, MouseDownEvent, Pixels, Point, WeakFocusHandle, Window,
};

/// Why a layer asks to close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Escape,
    PointerOutside,
    FocusOutside,
}

type Handler = Rc<dyn Fn(Reason, &mut Window, &mut App)>;

struct Entry {
    serial: u64,
    modal: bool,
    parent: Option<u64>,
    bounds: Bounds<Pixels>,
    /// Pointer downs here are not outside (the trigger, which toggles the layer itself).
    ignore: Vec<Bounds<Pixels>>,
    focus: Option<WeakFocusHandle>,
    ignore_focus: Vec<WeakFocusHandle>,
    on_dismiss: Option<Handler>,
}

#[derive(Default)]
struct Stack {
    entries: RefCell<Vec<Entry>>,
    next: Cell<u64>,
}

struct Shared(Rc<Stack>);

impl gpui::Global for Shared {}

fn stack(cx: &mut App) -> Rc<Stack> {
    if cx.try_global::<Shared>().is_none() {
        cx.set_global(Shared(Rc::default()));
    }
    cx.global::<Shared>().0.clone()
}

/// How many layers are open.
pub fn count(cx: &App) -> usize {
    cx.try_global::<Shared>()
        .map_or(0, |shared| shared.0.entries.borrow().len())
}

/// Whether a modal layer is open: the page is scroll-locked, outside pointer events are
/// blocked and focus is trapped (Radix `modal`).
pub fn modal_open(cx: &App) -> bool {
    cx.try_global::<Shared>()
        .is_some_and(|shared| shared.0.entries.borrow().iter().any(|e| e.modal))
}

/// Owns a registered layer; dropping it removes the layer from the stack.
pub struct Guard {
    stack: Rc<Stack>,
    serial: u64,
    last_focus: Rc<RefCell<Seen>>,
}

impl Guard {
    /// Opens a layer on top of the stack. `parent` is the layer it was opened from (a submenu's
    /// menu): pointer downs and focus inside a child count as inside the parent.
    pub fn open(cx: &mut App, modal: bool, parent: Option<&Handle>) -> Self {
        let stack = stack(cx);
        let serial = stack.next.get() + 1;
        stack.next.set(serial);
        stack.entries.borrow_mut().push(Entry {
            serial,
            modal,
            parent: parent.map(|handle| handle.serial),
            bounds: Bounds::default(),
            ignore: Vec::new(),
            focus: None,
            ignore_focus: Vec::new(),
            on_dismiss: None,
        });
        Self {
            stack,
            serial,
            last_focus: Rc::default(),
        }
    }

    pub fn handle(&self) -> Handle {
        Handle {
            stack: self.stack.clone(),
            serial: self.serial,
            last_focus: self.last_focus.clone(),
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.stack
            .entries
            .borrow_mut()
            .retain(|entry| entry.serial != self.serial);
    }
}

/// A layer's registration, shared with the element that paints it.
#[derive(Clone)]
pub struct Handle {
    stack: Rc<Stack>,
    serial: u64,
    last_focus: Rc<RefCell<Seen>>,
}

/// The focus a layer last saw; `started` is false until its first frame.
#[derive(Default)]
struct Seen {
    started: bool,
    focus: Option<FocusHandle>,
}

impl Handle {
    fn with<R>(&self, f: impl FnOnce(&mut Entry) -> R) -> Option<R> {
        let mut entries = self.stack.entries.borrow_mut();
        entries
            .iter_mut()
            .find(|entry| entry.serial == self.serial)
            .map(f)
    }

    pub fn is_top(&self) -> bool {
        self.stack
            .entries
            .borrow()
            .last()
            .is_some_and(|entry| entry.serial == self.serial)
    }
}

/// The entries from `serial` itself up the chain of layers it was opened from, and every layer
/// opened from it: the layer's React subtree.
fn family(entries: &[Entry], serial: u64) -> Vec<u64> {
    let mut family = vec![serial];
    for entry in entries {
        let mut at = entry.parent;
        while let Some(parent) = at {
            if parent == serial {
                family.push(entry.serial);
                break;
            }
            at = entries
                .iter()
                .find(|e| e.serial == parent)
                .and_then(|e| e.parent);
        }
    }
    family
}

/// Closes the topmost layer (Escape, from the window's key handler). True when one handled it.
pub fn escape(window: &mut Window, cx: &mut App) -> bool {
    let Some(shared) = cx.try_global::<Shared>() else {
        return false;
    };
    let handler = shared
        .0
        .entries
        .borrow()
        .last()
        .and_then(|entry| entry.on_dismiss.clone());
    let Some(handler) = handler else {
        return false;
    };
    handler(Reason::Escape, window, cx);
    true
}

/// A pointer down at `at`: closes `serial` when it is outside the layer and its family, and the
/// layer is not below a modal one.
fn pointer_down(handle: &Handle, at: Point<Pixels>, window: &mut Window, cx: &mut App) {
    let handler = {
        let entries = handle.stack.entries.borrow();
        let blocked = entries
            .iter()
            .rposition(|entry| entry.modal)
            .is_some_and(|modal| entries[modal].serial > handle.serial);
        let family = family(&entries, handle.serial);
        let inside = entries.iter().any(|entry| {
            (family.contains(&entry.serial) && entry.bounds.contains(&at))
                || (entry.serial == handle.serial
                    && entry.ignore.iter().any(|bounds| bounds.contains(&at)))
        });
        if blocked || inside {
            return;
        }
        entries
            .iter()
            .find(|entry| entry.serial == handle.serial)
            .and_then(|entry| entry.on_dismiss.clone())
    };
    if let Some(handler) = handler {
        handler(Reason::PointerOutside, window, cx);
    }
}

/// Focus moved to something outside the layer and its family.
fn focus_moved(handle: &Handle, window: &mut Window, cx: &mut App) {
    let focused = window.focused(cx);
    let moved = {
        let mut seen = handle.last_focus.borrow_mut();
        let moved = seen.started && seen.focus != focused;
        seen.started = true;
        seen.focus.clone_from(&focused);
        moved
    };
    if !moved || focused.is_none() {
        return;
    }
    let (handler, inside) = {
        let entries = handle.stack.entries.borrow();
        let family = family(&entries, handle.serial);
        let holds = |weak: &WeakFocusHandle| {
            weak.upgrade()
                .is_some_and(|focus| focus.contains_focused(window, cx))
        };
        let inside = entries.iter().any(|entry| {
            (family.contains(&entry.serial) && entry.focus.as_ref().is_some_and(holds))
                || (entry.serial == handle.serial && entry.ignore_focus.iter().any(holds))
        });
        let handler = entries
            .iter()
            .find(|entry| entry.serial == handle.serial)
            .and_then(|entry| entry.on_dismiss.clone());
        (handler, inside)
    };
    if let (false, Some(handler)) = (inside, handler) {
        window.defer(cx, move |window, cx| {
            handler(Reason::FocusOutside, window, cx);
        });
    }
}

/// What a layer tells the stack: how to close it, which focus handle holds its content and which
/// pointer and focus targets are not outside (the trigger).
pub struct Dismissable {
    handle: Handle,
    on_dismiss: Handler,
    focus: Option<FocusHandle>,
    ignore_focus: Vec<FocusHandle>,
    ignore: Vec<Rc<Cell<Option<Bounds<Pixels>>>>>,
    child: Option<AnyElement>,
}

impl Dismissable {
    pub fn new(
        handle: Handle,
        child: impl IntoElement,
        on_dismiss: impl Fn(Reason, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            handle,
            on_dismiss: Rc::new(on_dismiss),
            focus: None,
            ignore_focus: Vec::new(),
            ignore: Vec::new(),
            child: Some(child.into_any_element()),
        }
    }

    /// The focus handle that holds the layer's content.
    pub fn focus(mut self, focus: &FocusHandle) -> Self {
        self.focus = Some(focus.clone());
        self
    }

    /// The trigger: a pointer down on its `bounds` or focus on `focus` is not outside.
    pub fn ignore(
        mut self,
        bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
        focus: Option<&FocusHandle>,
    ) -> Self {
        self.ignore.push(bounds);
        self.ignore_focus.extend(focus.cloned());
        self
    }
}

impl IntoElement for Dismissable {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Dismissable {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        (child.request_layout(window, cx), child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        child.prepaint(window, cx);
        let ignore = self.ignore.iter().filter_map(|cell| cell.get()).collect();
        let (focus, ignore_focus) = (
            self.focus.as_ref().map(FocusHandle::downgrade),
            self.ignore_focus
                .iter()
                .map(FocusHandle::downgrade)
                .collect(),
        );
        let handler = self.on_dismiss.clone();
        self.handle.with(|entry| {
            entry.bounds = bounds;
            entry.ignore = ignore;
            entry.focus = focus;
            entry.ignore_focus = ignore_focus;
            entry.on_dismiss = Some(handler);
        });
        focus_moved(&self.handle, window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        child.paint(window, cx);
        let handle = self.handle.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase.capture() {
                pointer_down(&handle, event.position, window, cx);
            }
        });
    }
}
