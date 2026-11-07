// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `app/conversation-progress/*`: turn progress derived from the session view and live events.
use crate::ui::source::wire::{AppEventEnvelope, SessionView};

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Default)]
pub(crate) struct TurnProgress;

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
impl TurnProgress {
    /// Rebuilds progress from a session view.
    pub(crate) fn load(&mut self, _view: &SessionView) {}

    /// Applies a live event; returns whether progress changed.
    pub(crate) fn apply_event(&mut self, _event: &AppEventEnvelope) -> bool {
        false
    }
}
