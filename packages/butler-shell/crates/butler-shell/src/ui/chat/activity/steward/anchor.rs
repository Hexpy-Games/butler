//! Electron `stewardParentProgressProjection.ts`: anchor over visible messages.
use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{
    MessageRecord, MessageRecordRole, ProgressRow, SessionView, SessionViewTurn,
    StewardSessionSummaryView,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// `AnchoredStewardProgress`.
pub(super) struct Anchored<'a> {
    pub(super) child: &'a StewardSessionSummaryView,
    pub(super) turn: &'a SessionViewTurn,
    pub(super) rows: &'a [ProgressRow],
}

/// The assistant message that owns a child's card: both durable relation anchors must hold.
fn anchored_parent<'a>(
    messages: &'a [Arc<MessageRecord>],
    session_id: &str,
    child: &StewardSessionSummaryView,
) -> Option<&'a MessageRecord> {
    let relation = &child.relation;
    if relation.child_session_id != child.session_id {
        return None;
    }
    let Some(anchor_index) = messages
        .iter()
        .position(|message| message.id == relation.anchor_message_id)
    else {
        let at = messages.iter().position(|message| {
            message.role == MessageRecordRole::Assistant
                && message.turn_id.as_deref() == Some(relation.parent_turn_id.as_str())
        })?;
        return messages[at].initiated.is_some().then_some(&*messages[at]);
    };
    let anchor = &messages[anchor_index];
    if anchor.role != MessageRecordRole::User || anchor.chat_id.as_deref() != Some(session_id) {
        return None;
    }
    let parent_index = (anchor_index + 1..messages.len()).find(|at| {
        messages[*at].role == MessageRecordRole::Assistant
            && messages[*at].turn_id.as_deref() == Some(relation.parent_turn_id.as_str())
    })?;
    let preceding_user = messages[..parent_index]
        .iter()
        .rev()
        .find(|message| message.role == MessageRecordRole::User)?;
    if preceding_user.id != relation.anchor_message_id {
        return None;
    }
    Some(&*messages[parent_index])
}

/// Electron `anchoredStewardProgressByMessageId`: duplicate claims stay blocked.
pub(crate) fn steward_anchors(
    messages: &[Arc<MessageRecord>],
    view: &SessionView,
) -> HashMap<String, usize> {
    let mut anchors = HashMap::new();
    let mut blocked = HashSet::new();
    for (index, child) in view.steward_children.iter().flatten().enumerate() {
        if child
            .active_turn
            .as_ref()
            .or(child.latest_turn.as_ref())
            .is_none()
        {
            continue;
        }
        let Some(parent) = anchored_parent(messages, &view.session_id, child).filter(|parent| {
            !parent.id.is_empty() && parent.chat_id.as_deref() == Some(view.session_id.as_str())
        }) else {
            continue;
        };
        if blocked.contains(&parent.id) {
            continue;
        }
        if anchors.insert(parent.id.clone(), index).is_some() {
            anchors.remove(&parent.id);
            blocked.insert(parent.id.clone());
        }
    }
    anchors
}

/// Electron `AnchoredStewardProgress`: retrieve the precomputed visible-message anchor.
pub(super) fn anchored_progress<'a>(
    message: &MessageRecord,
    t: &TranscriptCtx<'a>,
) -> Option<Anchored<'a>> {
    let child = t
        .view
        .steward_children
        .as_ref()?
        .get(*t.steward.get(&message.id)?)?;
    let turn = child.active_turn.as_ref().or(child.latest_turn.as_ref())?;
    Some(Anchored {
        child,
        turn,
        rows: turn
            .progress
            .as_ref()
            .map_or(&[][..], |progress| progress.safe_progress_rows.as_slice()),
    })
}
