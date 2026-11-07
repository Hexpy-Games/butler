// Skeleton (Opus, P2 shell wave): the unit that owns this file fills it; see
// /Users/home-dev/p14-jobs/gpui-port-orch/specs/p2-shell-wave.md for the contract.
//! `OperationOutputDetails`, `operation*Presentation` (output via `get_operation_output`).
use gpui::{AnyElement, App, IntoElement as _, Window, div};

use crate::ui::chat::TranscriptCtx;

/// The paged output of one operation.
#[allow(dead_code, reason = "P2 shell-wave skeleton: wired by Opus at wave integration")]
pub(crate) fn operation_output(
    _turn_id: &str,
    _request_id: &str,
    _t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    div().into_any_element()
}
