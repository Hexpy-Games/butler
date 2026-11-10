//! The turn helpers of `useMessageList` and `useLiveMessageId`: which assistant attempts show,
//! whether the running turn shows its activity, and which message carries it.
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use crate::ui::source::wire::{
    MessageRecord, MessageRecordRole, ProgressRow, QueuedMessageRecordState, SessionQueueView,
    SessionView,
};

/// `ACTIVE_TURN_STATES` (app/constants.ts).
const ACTIVE_TURN_STATES: [&str; 7] = [
    "accepted",
    "thinking",
    "streaming",
    "waiting_for_form",
    "waiting_for_tool",
    "cancelling",
    "retrying",
];

/// `isTerminalProgressState` (app/utils.ts).
pub(super) fn is_terminal(state: &str) -> bool {
    matches!(
        state,
        "failed" | "cancelled" | "delivered" | "complete" | "completed" | "stopped"
    )
}

fn turn_of(message: &MessageRecord) -> Option<&str> {
    message.turn_id.as_deref().filter(|id| !id.is_empty())
}

fn cursor_of(message: &MessageRecord) -> i64 {
    message.cursor.unwrap_or(0)
}

/// `isAssistantFailureNoticeMessage` (app/utils.ts).
fn is_failure_notice(message: &MessageRecord) -> bool {
    message.role == MessageRecordRole::Assistant
        && message.status.as_deref() == Some("failed")
        && message
            .safe_error_code
            .as_deref()
            .is_some_and(|code| !code.is_empty())
}

/// `collapseAssistantAttempts` (app/utils.ts): one message per turn attempt, a failure notice
/// folded into its partial answer.
pub(super) fn collapse_assistant_attempts(
    messages: &[Arc<MessageRecord>],
) -> Vec<Arc<MessageRecord>> {
    let mut latest: HashMap<&str, &Arc<MessageRecord>> = HashMap::new();
    for message in messages {
        let Some(turn) = turn_of(message) else {
            continue;
        };
        if message.role == MessageRecordRole::User {
            continue;
        }
        if latest
            .get(turn)
            .is_none_or(|previous| cursor_of(message) >= cursor_of(previous))
        {
            latest.insert(turn, message);
        }
    }
    let mut partial: HashMap<&str, &Arc<MessageRecord>> = HashMap::new();
    for message in messages {
        if let (MessageRecordRole::Assistant, Some(true), Some(turn)) =
            (&message.role, message.incomplete, turn_of(message))
        {
            partial.insert(turn, message);
        }
    }
    messages
        .iter()
        .filter(|message| {
            let turn = turn_of(message);
            if is_failure_notice(message) && turn.is_some_and(|turn| partial.contains_key(turn)) {
                return false;
            }
            message.role == MessageRecordRole::User
                || turn.is_none()
                || message.status.as_deref() == Some("delivered")
                || message.incomplete == Some(true)
                || turn
                    .and_then(|turn| latest.get(turn))
                    .is_some_and(|latest| latest.id == message.id)
        })
        .map(|message| {
            let failure = turn_of(message)
                .and_then(|turn| latest.get(turn))
                .filter(|failure| is_failure_notice(failure));
            match (failure, turn_of(message).and_then(|turn| partial.get(turn))) {
                (Some(failure), Some(partial)) if std::ptr::eq(*partial, message) => {
                    Arc::new(MessageRecord {
                        failure_notice: Some(Box::new((***failure).clone())),
                        ..(**message).clone()
                    })
                }
                _ => message.clone(),
            }
        })
        .collect()
}

/// What the running turn shows: its id, a content signature of its progress, and whether
/// the activity shows at all (`shouldShowTurnActivity`).
pub(super) struct TurnInfo {
    pub(super) turn_id: String,
    pub(super) signature: String,
    pub(super) show: bool,
}

fn progress_signature(rows: &[ProgressRow], state: &str) -> String {
    let last = rows.last();
    format!(
        "{}|{}|{}|{}",
        rows.len(),
        last.map_or("", |row| row.id.as_str()),
        last.map_or("", |row| row.state.as_str()),
        state
    )
}

/// The active turn of a session view, `None` when no turn runs.
pub(super) fn turn_info(view: &SessionView) -> Option<TurnInfo> {
    let turn = view.active_turn.as_ref()?;
    let snapshot = turn.progress.as_ref();
    let state = snapshot
        .and_then(|snapshot| snapshot.state.as_deref())
        .unwrap_or(&turn.state);
    if !ACTIVE_TURN_STATES.contains(&state) {
        return None;
    }
    let rows: &[ProgressRow] = snapshot.map_or(&[], |snapshot| &snapshot.safe_progress_rows);
    let has_todo = rows.iter().any(|row| row.kind.as_deref() == Some("todo"));
    let timeline = rows
        .iter()
        .filter(|row| row.kind.as_deref() != Some("todo"))
        .count();
    let internal_continuation = matches!(state, "retrying" | "waiting_for_tool");
    let show =
        !(timeline == 0 && !has_todo && internal_continuation) && (!has_todo || timeline > 0);
    let turn_id = snapshot
        .and_then(|snapshot| snapshot.turn_id.clone())
        .unwrap_or_else(|| turn.id.clone());
    Some(TurnInfo {
        turn_id,
        signature: progress_signature(rows, state),
        show,
    })
}

/// `useLiveMessageId`'s held state: the turn the activity is attached to and, once that message
/// settled, the progress it settled with.
#[derive(Default)]
pub(super) struct Live {
    attached: Option<String>,
    held: Option<(String, String)>,
}

fn is_live(message: &MessageRecord) -> bool {
    !is_terminal(message.status.as_deref().unwrap_or(""))
}

fn last_turn_message<'a>(
    messages: &'a [Arc<MessageRecord>],
    turn_id: Option<&str>,
) -> Option<(usize, &'a MessageRecord)> {
    messages.iter().enumerate().rev().find_map(|(ix, message)| {
        if message.role != MessageRecordRole::Assistant {
            return None;
        }
        let matches = match turn_id {
            Some(turn) => turn_of(message) == Some(turn),
            None => is_live(message),
        };
        matches.then_some((ix, &**message))
    })
}

impl Live {
    /// The index of the message that carries the running turn's live activity. Only a message
    /// that has not settled takes it; one that settles while it carries the activity keeps it
    /// until the progress changes or detaches, so completion does not flicker.
    pub(super) fn message(
        &mut self,
        messages: &[Arc<MessageRecord>],
        info: Option<&TurnInfo>,
    ) -> Option<usize> {
        let candidate = info.filter(|info| info.show).and_then(|info| {
            last_turn_message(
                messages,
                Some(info.turn_id.as_str()).filter(|id| !id.is_empty()),
            )
        });
        let progress = info.map_or_else(String::new, |info| info.signature.clone());
        let mut found = None;
        let mut attached = None;
        let mut held = None;
        if let Some((ix, message)) = candidate {
            let key = turn_of(message).unwrap_or(&message.id).to_owned();
            if is_live(message) {
                found = Some(ix);
                attached = Some(key);
            } else if self.attached.as_deref() == Some(key.as_str()) {
                let own = self.held.clone().filter(|(held_key, _)| *held_key == key);
                if own
                    .as_ref()
                    .is_none_or(|(_, signature)| *signature == progress)
                {
                    found = Some(ix);
                    held = own.or_else(|| Some((key.clone(), progress)));
                    attached = Some(key);
                }
            }
        }
        self.attached = attached;
        self.held = held;
        found
    }
}

/// Reuses `previous` when it equals `next` (rows compare by pointer).
pub(super) fn reuse<T: PartialEq>(previous: Option<&Rc<T>>, next: T) -> Rc<T> {
    match previous {
        Some(previous) if **previous == next => previous.clone(),
        _ => Rc::new(next),
    }
}

/// `queuedConversationItems`: whether a queued follow-up still waits or failed, and is not yet
/// a message of the transcript.
pub(super) fn has_visible_queue(
    queue: &SessionQueueView,
    messages: &[Arc<MessageRecord>],
    session: &str,
) -> bool {
    let shown = |id: &str| messages.iter().any(|message| message.id == id);
    queue.queued_messages.iter().any(|record| {
        let key = record.client_message_id.as_deref().unwrap_or(&record.id);
        record.chat_id == session
            && matches!(
                record.state,
                QueuedMessageRecordState::Queued | QueuedMessageRecordState::Failed
            )
            && !shown(key)
            && !record.dispatched_message_id.as_deref().is_some_and(shown)
    })
}

/// The last message's identity, cursor, status and length: the key a changed transcript bumps.
pub(super) fn version(messages: &[Arc<MessageRecord>]) -> String {
    messages.last().map_or_else(
        || "empty".to_owned(),
        |last| {
            format!(
                "{}:{}:{}:{}",
                last.id,
                last.cursor
                    .map_or_else(String::new, |cursor| cursor.to_string()),
                last.status.as_deref().unwrap_or(""),
                last.text.len()
            )
        },
    )
}
