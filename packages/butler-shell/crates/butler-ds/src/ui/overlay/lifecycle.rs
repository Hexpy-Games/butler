//! An overlay's open, exiting and closed phases. Opening registers the layer on the dismiss
//! stack; closing unregisters it, snapshots the position the surface resolved (the exit freeze,
//! card section 0.6) and keeps the surface mounted for the exit animation, which a timer then
//! ends. Radix Presence plus `usePopperExitFreezeRef`.
use std::time::{Duration, Instant};

use gpui::{App, Context, Entity, Window};

use super::dismiss::{Guard, Handle};
use super::place::Resolved;
use super::popper::Output;

/// Where the overlay is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    Closed,
    /// `key` changes with every open, so each enter restarts its animation.
    Open {
        key: usize,
    },
    /// Closing: the surface fades out at the position `frozen` it had when the close began.
    Exiting {
        key: usize,
        frozen: Option<Resolved>,
    },
}

/// What a layer is on the dismiss stack.
#[derive(Clone, Default)]
pub struct Spec {
    pub modal: bool,
    pub parent: Option<Handle>,
}

/// The per-overlay runtime state; keep it in a keyed state entity.
#[derive(Default)]
pub struct Lifecycle {
    open: bool,
    key: usize,
    closed_at: Option<Instant>,
    frozen: Option<Resolved>,
    guard: Option<Guard>,
}

/// The phase now, and the layer's stack handle while it is open.
pub struct Synced {
    pub phase: Phase,
    pub handle: Option<Handle>,
}

impl Lifecycle {
    /// Follows `open` (the root's or the caller's state) for this frame.
    pub fn sync(
        state: &Entity<Self>,
        open: bool,
        spec: &Spec,
        output: &Output,
        exit: Duration,
        window: &mut Window,
        cx: &mut App,
    ) -> Synced {
        let now = cx.background_executor().now();
        let (synced, started_exit) = state.update(cx, |s, cx| {
            let started = s.follow(open, spec, output, now, cx);
            let exiting = s
                .closed_at
                .is_some_and(|at| now.saturating_duration_since(at) < exit);
            let phase = match (open, exiting) {
                (true, _) => Phase::Open { key: s.key },
                (false, true) => Phase::Exiting {
                    key: s.key,
                    frozen: s.frozen,
                },
                (false, false) => Phase::Closed,
            };
            let handle = s.guard.as_ref().map(Guard::handle);
            (Synced { phase, handle }, started && !exit.is_zero())
        });
        if started_exit {
            let entity = state.clone();
            crate::ui::motion::delay(window, cx, exit, move |_, cx| {
                entity.update(cx, |_, cx| cx.notify());
            });
        }
        synced
    }

    /// Applies an open or close edge. True when a close just began.
    fn follow(
        &mut self,
        open: bool,
        spec: &Spec,
        output: &Output,
        now: Instant,
        cx: &mut Context<Self>,
    ) -> bool {
        if open && !self.open {
            self.open = true;
            self.key += 1;
            self.closed_at = None;
            self.frozen = None;
            output.clear();
            self.guard = Some(Guard::open(cx, spec.modal, spec.parent.as_ref()));
        } else if !open && self.open {
            self.open = false;
            self.closed_at = Some(now);
            self.frozen = output.get();
            self.guard = None;
            return true;
        }
        false
    }
}
