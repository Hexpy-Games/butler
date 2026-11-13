//! `messageCache`, `sessionViewWindow`: the open session's view and its message window.
use crate::ui::source::wire::{
    AnsweredUserQuestions, AppEventEnvelope, MessageRecord, MessageRecordRole, SessionView,
};
use chrono::DateTime;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// A reply still being written; mirrors `LIVE_MESSAGE_STATUSES`.
const LIVE_MESSAGE_STATUSES: [&str; 4] = ["pending", "thinking", "streaming", "retrying"];

/// The open session's view, paged older on demand and patched by live events.
#[derive(Default)]
pub(crate) struct MessageCache {
    view: Option<SessionView>,
}

impl MessageCache {
    /// Replaces the cache with a freshly opened session view.
    pub(crate) fn open(&mut self, view: SessionView) {
        self.view = Some(view);
    }

    /// Merges the latest window into the shown view: the view's own fields come from `latest`,
    /// its messages merge into the current ones, and older windows already paged in stay.
    pub(crate) fn refresh(&mut self, mut latest: SessionView) {
        let Some(view) = self
            .view
            .as_mut()
            .filter(|v| v.session_id == latest.session_id)
        else {
            self.view = Some(latest);
            return;
        };
        let mut messages = std::mem::take(&mut view.messages);
        merge_messages(&mut messages, std::mem::take(&mut latest.messages));
        latest.messages = messages;
        latest.question_answers = merge_answers(
            view.question_answers.take(),
            latest.question_answers.take(),
            &latest.messages,
        );
        let paged_further = match (
            view.message_window.previous_cursor,
            latest.message_window.previous_cursor,
        ) {
            (None, _) => true,
            (Some(known), Some(newest)) => known < newest,
            (Some(_), None) => false,
        };
        if paged_further {
            let known = &view.message_window;
            let window = &mut latest.message_window;
            window.previous_cursor = known.previous_cursor;
            window
                .previous_cursor_token
                .clone_from(&known.previous_cursor_token);
            window.has_more = known.has_more;
            window.complete = known.complete;
        }
        let history = latest.activity_history.get_or_insert_with(Vec::new);
        for entry in view.activity_history.take().into_iter().flatten() {
            if !history.iter().any(|known| known.turn_id == entry.turn_id) {
                history.push(entry);
            }
        }
        *view = latest;
    }

    /// Merges an older window in front of the current messages.
    pub(crate) fn prepend_older(&mut self, older: SessionView) {
        let Some(view) = self.view.as_mut() else {
            self.view = Some(older);
            return;
        };
        if view.session_id != older.session_id {
            return;
        }
        merge_messages(&mut view.messages, older.messages);
        view.question_answers = merge_answers(
            view.question_answers.take(),
            older.question_answers,
            &view.messages,
        );
        if let Some(entries) = older.activity_history {
            let history = view.activity_history.get_or_insert_with(Vec::new);
            for entry in entries {
                match history
                    .iter_mut()
                    .find(|known| known.turn_id == entry.turn_id)
                {
                    Some(known) => *known = entry,
                    None => history.push(entry),
                }
            }
        }
        view.message_window.previous_cursor = older.message_window.previous_cursor;
        view.message_window.previous_cursor_token = older.message_window.previous_cursor_token;
    }

    /// Applies a live event; returns whether the view changed.
    pub(crate) fn apply_event(&mut self, event: &AppEventEnvelope) -> bool {
        let Some(view) = self.view.as_mut() else {
            return false;
        };
        match event.r#type.as_str() {
            "message.created" | "message.updated" => {
                let Some(message) = event
                    .payload
                    .get("message")
                    .and_then(|raw| serde_json::from_value::<MessageRecord>(raw.clone()).ok())
                else {
                    return false;
                };
                if message.chat_id.as_deref() != Some(view.session_id.as_str()) {
                    return false;
                }
                merge_messages(&mut view.messages, vec![Arc::new(message)])
            }
            "message.deleted" => {
                let payload = |key: &str| event.payload.get(key).and_then(|v| v.as_str());
                let (Some(chat), Some(id)) = (payload("chat_id"), payload("message_id")) else {
                    return false;
                };
                if chat != view.session_id {
                    return false;
                }
                let before = view.messages.len();
                view.messages.retain(|message| message.id != id);
                view.messages.len() != before
            }
            _ => false,
        }
    }

    pub(crate) fn view(&self) -> Option<&SessionView> {
        self.view.as_ref()
    }

    /// The shown messages, for the freeze of a finished turn's activity.
    pub(crate) fn messages_mut(&mut self) -> &mut [Arc<MessageRecord>] {
        self.view
            .as_mut()
            .map_or(&mut [], |view| view.messages.as_mut_slice())
    }
}

/// ```ts
/// const retained = [...loaded, ...view.messages];
/// const turns = new Set(retained.map(m => m.turn_id));
/// const messageIds = new Set(retained.map(m => m.id));
/// const answers = new Map([...previous?.question_answers ?? [], ...view.question_answers ?? []].map(a => [a.request_ref, a]));
/// view = { ...view, question_answers: [...answers.values()].filter(a => turns.has(a.source_turn_id) || messageIds.has(a.followup_message_id)) };
/// ```
fn merge_answers(
    previous: Option<Vec<AnsweredUserQuestions>>,
    incoming: Option<Vec<AnsweredUserQuestions>>,
    messages: &[Arc<MessageRecord>],
) -> Option<Vec<AnsweredUserQuestions>> {
    if previous.is_none() && incoming.is_none() {
        return None;
    }
    let turns: HashSet<_> = messages
        .iter()
        .filter_map(|m| m.turn_id.as_deref())
        .collect();
    let message_ids: HashSet<_> = messages.iter().map(|m| m.id.as_str()).collect();
    let mut answers = Vec::new();
    let mut index = HashMap::new();
    for answer in previous
        .into_iter()
        .flatten()
        .chain(incoming.into_iter().flatten())
    {
        if let Some(&at) = index.get(&answer.request_ref) {
            answers[at] = answer;
        } else {
            index.insert(answer.request_ref.clone(), answers.len());
            answers.push(answer);
        }
    }
    answers.retain(|answer| {
        turns.contains(answer.source_turn_id.as_str())
            || message_ids.contains(answer.followup_message_id.as_str())
    });
    Some(answers)
}

/// `mergeMessages`: by id, the incoming record merged over the current one, in cursor order.
fn merge_messages(
    current: &mut Vec<Arc<MessageRecord>>,
    incoming: Vec<Arc<MessageRecord>>,
) -> bool {
    let mut index: HashMap<String, usize> = current
        .iter()
        .enumerate()
        .map(|(at, message)| (message.id.clone(), at))
        .collect();
    let mut changed = false;
    for message in incoming {
        if message.id.is_empty() {
            continue;
        }
        match index.get(&message.id) {
            Some(&at) => changed |= replace_record(&mut current[at], message),
            None => {
                index.insert(message.id.clone(), current.len());
                current.push(message);
                changed = true;
            }
        }
    }
    if changed {
        current.sort_by_key(|message| message_cursor(message));
    }
    changed
}

/// `mergeMessageRecord`: keeps the settled record against an older copy and the work
/// blocks and activity rows the incoming record lacks. Returns whether `previous` changed.
fn replace_record(previous: &mut Arc<MessageRecord>, incoming: Arc<MessageRecord>) -> bool {
    if is_stale_message_record(previous, &incoming) {
        return false;
    }
    let mut next = Arc::unwrap_or_clone(incoming);
    if next.work_blocks.is_none() && previous.work_blocks.as_ref().is_some_and(|b| !b.is_empty()) {
        next.work_blocks.clone_from(&previous.work_blocks);
    }
    if next.turn_activity_rows.is_none()
        && previous
            .turn_activity_rows
            .as_ref()
            .is_some_and(|r| !r.is_empty())
    {
        next.turn_activity_rows
            .clone_from(&previous.turn_activity_rows);
    }
    if **previous == next {
        return false;
    }
    *previous = Arc::new(next);
    true
}

/// `isStaleMessageRecord`: a snapshot resolved after the final message event is older (an
/// earlier `updated_at`, or a live status at the same instant) and must not roll it back.
/// Only assistant records qualify; user rows carry the client clock.
fn is_stale_message_record(previous: &MessageRecord, incoming: &MessageRecord) -> bool {
    if !is_assistant(previous) || !is_assistant(incoming) {
        return false;
    }
    let (Some(previous_at), Some(incoming_at)) = (updated_at(previous), updated_at(incoming))
    else {
        return false;
    };
    incoming_at < previous_at
        || incoming_at == previous_at && is_live(incoming) && !is_live(previous)
}

fn is_assistant(message: &MessageRecord) -> bool {
    matches!(message.role, MessageRecordRole::Assistant)
}

fn is_live(message: &MessageRecord) -> bool {
    message
        .status
        .as_deref()
        .is_some_and(|status| LIVE_MESSAGE_STATUSES.contains(&status))
}

fn updated_at(message: &MessageRecord) -> Option<i64> {
    let raw = message.updated_at.as_deref()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|at| at.timestamp_millis())
}

fn message_cursor(message: &MessageRecord) -> i64 {
    message.cursor.unwrap_or(0)
}
