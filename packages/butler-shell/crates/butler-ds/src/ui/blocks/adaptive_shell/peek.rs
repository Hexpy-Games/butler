//! The collapsed sidebar's peek (useSidebarPeek.ts, sidebarPeek.ts): hovering the left edge asks
//! for it; the pointer leaving the card (after a short delay that coming back cancels), window
//! deactivation, Escape and a press outside close it. A host that draws a native view the
//! pointer can hide behind reports positions or the pointer's absence.
use std::time::Duration;

use gpui::{App, Bounds, ElementId, Entity, Pixels, Point, Window};

/// How long the pointer may be away from the peeked sidebar before it closes.
pub const PEEK_DISMISS_MS: u64 = 240; // DS: sidebarPeek.ts:2

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    PointerLeft,
    PointerOutside,
    WindowBlur,
    Escape,
    PressOutside,
    Disabled,
}

#[derive(Default)]
struct State {
    open: bool,
    /// Bumped whenever the dismiss timer is armed or cancelled, so a stale timer does nothing.
    timer: Option<usize>,
    generation: usize,
    last_close: Option<CloseReason>,
}

/// Every peek made so far, so the host's window-level key and activation handlers can reach
/// them (a key reaches only the focused path of the tree, as the document's keydown does not).
#[derive(Default)]
struct Registry(Vec<Entity<State>>);

impl gpui::Global for Registry {}

/// Escape closes every open peek. The host calls it from its window-level key handler.
pub fn escape(window: &mut Window, cx: &mut App) {
    close_all(CloseReason::Escape, window, cx);
}

/// The window lost focus: every open peek closes. The host calls it from its activation observer.
pub fn window_blurred(window: &mut Window, cx: &mut App) {
    close_all(CloseReason::WindowBlur, window, cx);
}

fn close_all(reason: CloseReason, window: &mut Window, cx: &mut App) {
    let peeks = cx.default_global::<Registry>().0.clone();
    for state in peeks {
        let peek = SidebarPeek {
            state,
            enabled: true,
        };
        if peek.state.read(cx).open {
            peek.close(reason, window, cx);
        }
    }
}

/// The peek of one shell: its state is window state keyed by `id`.
#[derive(Clone)]
pub struct SidebarPeek {
    state: Entity<State>,
    /// Peek is possible (the sidebar is collapsed and not a drawer).
    enabled: bool,
}

impl SidebarPeek {
    /// The peek `id`; turning `enabled` off closes it.
    pub fn new(id: impl Into<ElementId>, enabled: bool, window: &mut Window, cx: &mut App) -> Self {
        let state = window.use_keyed_state((id.into(), "peek"), cx, |_, _| State::default());
        let registry = cx.default_global::<Registry>();
        if !registry
            .0
            .iter()
            .any(|known| known.entity_id() == state.entity_id())
        {
            registry.0.push(state.clone());
        }
        if !enabled && state.read(cx).open {
            state.update(cx, |state, cx| {
                *state = State {
                    generation: state.generation + 1,
                    last_close: Some(CloseReason::Disabled),
                    ..State::default()
                };
                cx.notify();
            });
        }
        Self { state, enabled }
    }

    pub fn open(&self, cx: &App) -> bool {
        self.enabled && self.state.read(cx).open
    }

    /// Why the peek last closed, for the host.
    pub fn last_close(&self, cx: &App) -> Option<CloseReason> {
        self.state.read(cx).last_close
    }

    /// Opens (the left-edge hover zone).
    pub fn show(&self, window: &mut Window, cx: &mut App) {
        if !self.enabled {
            return;
        }
        self.state.update(cx, |state, cx| {
            state.generation += 1;
            state.timer = None;
            if !state.open {
                state.open = true;
                cx.notify();
            }
        });
        window.refresh();
    }

    pub fn close(&self, reason: CloseReason, window: &mut Window, cx: &mut App) {
        self.state.update(cx, |state, cx| {
            state.generation += 1;
            state.timer = None;
            if state.open {
                state.open = false;
                state.last_close = Some(reason);
                cx.notify();
            }
        });
        window.refresh();
    }

    /// The pointer entered the sidebar (or the toggle over it): stay open.
    pub fn pointer_enter(&self, cx: &mut App) {
        self.state.update(cx, |state, _| {
            state.generation += 1;
            state.timer = None;
        });
    }

    /// The pointer left the sidebar for another surface: arm the dismiss timer.
    pub fn pointer_leave(&self, window: &mut Window, cx: &mut App) {
        self.arm(CloseReason::PointerLeft, window, cx);
    }

    /// The host says the pointer is over a surface the window cannot see (a native view).
    pub fn pointer_outside(&self, window: &mut Window, cx: &mut App) {
        self.arm(CloseReason::PointerOutside, window, cx);
    }

    /// A host-reported pointer position in window px: inside the peeked card cancels the
    /// dismissal, anywhere else arms it.
    pub fn pointer_at(
        &self,
        point: Point<Pixels>,
        sidebar: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        if sidebar.contains(&point) {
            self.pointer_enter(cx);
        } else {
            self.pointer_outside(window, cx);
        }
    }

    fn arm(&self, reason: CloseReason, window: &mut Window, cx: &mut App) {
        let armed = self.state.update(cx, |state, _| {
            if !state.open || state.timer.is_some() {
                return None;
            }
            state.generation += 1;
            state.timer = Some(state.generation);
            Some(state.generation)
        });
        let Some(generation) = armed else {
            return;
        };
        let peek = self.clone();
        window
            .spawn(cx, async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(PEEK_DISMISS_MS))
                    .await;
                cx.update(|window, cx| {
                    if peek.state.read(cx).timer == Some(generation) {
                        peek.close(reason, window, cx);
                    }
                })
                .ok();
            })
            .detach();
    }
}
