//! `ConversationRequestSlot` and `ConversationRequestPortal`: the row that holds the open
//! session's decision (approval, question, plan or handoff) in the transcript.
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::message_row::{MessageRow, Role};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use crate::ui::chat::TranscriptCtx;
use crate::ui::decisions::{DecisionCtx, decision_surface};

/// The decision's row, `None` while nothing waits.
pub(super) fn request_row(
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let ctx = DecisionCtx { view: t.view };
    let surface = decision_surface(ctx, Placement::Conversation, window, cx)?;
    Some(
        MessageRow::new("pending-request", Role::Assistant)
            .child(surface)
            .into_any_element(),
    )
}
