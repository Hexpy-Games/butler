//! `MessageContent`: the body of one message by role, its attachments, the response footer of
//! an answer and the retry actions of a failed message.
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window, div};

use super::TranscriptCtx;
use super::assistant::{
    assistant_message, can_retry_with_current_controls, message_retry_actions, retryable,
};
use super::files::message_files;
use super::row::visible_system_message_text;
use super::user::user_body;
use crate::ui::source::wire::{MessageRecord, MessageRecordRole};

/// The children of a message's row, in order.
pub(super) fn message_content(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let mut scoped: TranscriptCtx<'_> = t.clone();
    scoped.message_id = Some(msg.id.as_str());
    let t = &scoped;
    if msg.role == MessageRecordRole::Assistant {
        return assistant_message(msg, t, window, cx);
    }
    let mut parts = vec![match msg.role {
        MessageRecordRole::User => user_body(msg, t, window, cx),
        _ => div()
            .child(butler_ds::ui::selectable::Run::plain(
                visible_system_message_text(msg, cx),
                butler_ds::ui::selectable::Break::Paragraph,
            ))
            .into_any_element(),
    }];
    parts.extend(message_files(msg, t, window, cx));
    if msg.status.as_deref() == Some("failed")
        && retryable(msg)
        && let Some(turn_id) = msg.turn_id.as_deref().filter(|id| !id.is_empty())
    {
        parts.push(message_retry_actions(
            turn_id,
            can_retry_with_current_controls(msg),
            t,
            cx,
        ));
    }
    parts
}
