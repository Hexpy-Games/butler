// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `messageCache`, `sessionViewWindow`: the open session's view and its message window.
use crate::ui::source::wire::{AppEventEnvelope, SessionView};

/// The open session's view, paged older on demand and patched by live events.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Default)]
pub(crate) struct MessageCache {
    view: Option<SessionView>,
}

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
impl MessageCache {
    /// Replaces the cache with a freshly opened session view.
    pub(crate) fn open(&mut self, view: SessionView) {
        self.view = Some(view);
    }

    /// Merges an older window in front of the current messages.
    pub(crate) fn prepend_older(&mut self, _older: SessionView) {}

    /// Applies a live event; returns whether the view changed.
    pub(crate) fn apply_event(&mut self, _event: &AppEventEnvelope) -> bool {
        false
    }

    pub(crate) fn view(&self) -> Option<&SessionView> {
        self.view.as_ref()
    }
}
