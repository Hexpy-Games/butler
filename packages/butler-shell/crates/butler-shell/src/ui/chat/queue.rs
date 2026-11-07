//! `QueuedMessageItem`, `queuedConversationItems`, the queue hooks.
use std::collections::HashSet;

use std::rc::Rc;

use butler_ds::ui::blocks::queued_message::{QueuedMessage, QueuedTone};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Toast};
use gpui::{
    AnyElement, App, Entity, Global, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div,
};

use super::TranscriptCtx;
use crate::ui::composer::queue::load_queued_into_composer;
use crate::ui::i18n::media::Media;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{QueuedMessageRecord, QueuedMessageRecordState, SessionQueueView};

/// One queue record shown after the messages (`QueuedConversationItem`).
struct Item<'a> {
    key: String,
    record: &'a QueuedMessageRecord,
    tone: QueuedTone,
    can_send_now: bool,
    /// 1-based place among waiting messages; 0 for failed sends.
    position: usize,
    /// Number of waiting (not failed) messages.
    total: usize,
}

/// Stable across the optimistic record and the server record of one send.
fn queued_message_key(record: &QueuedMessageRecord) -> String {
    record
        .client_message_id
        .clone()
        .unwrap_or_else(|| record.id.clone())
}

/// Queue records shown after the messages, preserving waiting order while sending.
fn queued_conversation_items<'a>(
    queue: &'a SessionQueueView,
    chat_id: &str,
    shown: &HashSet<&str>,
    sending_keys: &HashSet<String>,
) -> Vec<Item<'a>> {
    let visible: Vec<&QueuedMessageRecord> = queue
        .queued_messages
        .iter()
        .filter(|record| record.chat_id == chat_id)
        .filter(|record| {
            !shown.contains(queued_message_key(record).as_str())
                && !record
                    .dispatched_message_id
                    .as_deref()
                    .is_some_and(|id| shown.contains(id))
                && matches!(
                    record.state,
                    QueuedMessageRecordState::Queued | QueuedMessageRecordState::Failed
                )
        })
        .collect();
    let total = visible
        .iter()
        .filter(|record| record.state != QueuedMessageRecordState::Failed)
        .count();
    let mut position = 0;
    visible
        .into_iter()
        .map(|record| {
            let key = queued_message_key(record);
            if record.state == QueuedMessageRecordState::Failed {
                return Item {
                    key,
                    record,
                    tone: QueuedTone::Failed,
                    can_send_now: false,
                    position: 0,
                    total,
                };
            }
            position += 1;
            Item {
                tone: if sending_keys.contains(&key) {
                    QueuedTone::Sending
                } else {
                    QueuedTone::Queued
                },
                key,
                record,
                can_send_now: position == 1,
                position,
                total,
            }
        })
        .collect()
}

/// `useQueuedMessageActions` pending Send now keys and `useEnteringKeys` of the queue rows,
/// kept per chat.
#[derive(Default)]
struct QueueState {
    pending: HashSet<String>,
    known: Option<HashSet<String>>,
    entering: HashSet<String>,
}

impl QueueState {
    /// `clearMissing` and `useEnteringKeys`: keys gone from the rows are forgotten; keys that
    /// appear after the first render enter.
    fn observe(&mut self, keys: &[String]) {
        let visible: HashSet<&String> = keys.iter().collect();
        self.pending.retain(|key| visible.contains(key));
        self.entering.retain(|key| visible.contains(key));
        if let Some(known) = &self.known {
            let fresh: Vec<String> = keys
                .iter()
                .filter(|key| !known.contains(*key))
                .cloned()
                .collect();
            self.entering.extend(fresh);
        }
        self.known
            .get_or_insert_with(HashSet::new)
            .extend(keys.iter().cloned());
    }
}

/// A queue route call.
enum Op {
    Delete(String),
    SendNow(String),
}

type Changed = Rc<dyn Fn(&mut App)>;

#[derive(Default)]
struct QueueChanged(Option<Changed>);

impl Global for QueueChanged {}

/// Registers what refreshes the session's queue in the Store; it runs after a queue row's
/// delete or send-now call ended.
pub(crate) fn on_queue_changed(cx: &mut App, handler: impl Fn(&mut App) + 'static) {
    cx.default_global::<QueueChanged>().0 = Some(Rc::new(handler));
}

fn queue_changed(cx: &mut App) {
    if let Some(handler) = cx
        .try_global::<QueueChanged>()
        .and_then(|changed| changed.0.clone())
    {
        handler(cx);
    }
}

/// Runs the route on the agent worker; true when the agent accepted it.
fn request(cx: &App, op: Op) -> futures::future::BoxFuture<'static, bool> {
    let done = Jobs::run(cx, move |client| async move {
        match op {
            Op::Delete(id) => client.delete_queued_message(&id).await.is_ok(),
            Op::SendNow(id) => client.send_queued_message_now(&id).await.is_ok(),
        }
    });
    Box::pin(async move { done.await.unwrap_or(false) })
}

/// `queuedStatus`
fn queued_status(item: &Item, lang: Lang, copy: &Media) -> String {
    match item.tone {
        QueuedTone::Sending => copy.sending_status.to_owned(),
        QueuedTone::Failed => copy.failed_message_status.to_owned(),
        QueuedTone::Queued if item.total > 1 => {
            Media::queued_position(lang, item.position, item.total)
        }
        QueuedTone::Queued => copy.queued_message_status.to_owned(),
    }
}

/// `queuedText`
fn queued_text(record: &QueuedMessageRecord, lang: Lang, copy: &Media) -> String {
    let attachments = record.attachments.as_deref().unwrap_or_default();
    let text = if !record.text.is_empty() {
        record.text.clone()
    } else {
        attachments.first().map_or_else(
            || copy.queued_message.to_owned(),
            |file| file.safe_name.clone(),
        )
    };
    if !record.text.is_empty() && !attachments.is_empty() {
        format!(
            "{text}\n{}",
            Media::queued_attachment_count(lang, attachments.len())
        )
    } else {
        text
    }
}

/// `QueuedMessageItem`
fn queued_message_item(
    item: &Item,
    entering: bool,
    state: &Entity<QueueState>,
    lang: Lang,
) -> QueuedMessage {
    let copy = Media::of(lang);
    let failed = item.tone == QueuedTone::Failed;
    let id = SharedString::from(format!("queued-{}", item.key));
    let (edit_label, delete_label) = if failed {
        (copy.retry_failed_message, copy.delete_failed_message)
    } else {
        (copy.edit_queued_message, copy.delete_queued_message)
    };
    let record = item.record.clone();
    let record_id = item.record.id.clone();
    let mut row = QueuedMessage::new(
        id,
        queued_text(item.record, lang, copy),
        queued_status(item, lang, copy),
    )
    .tone(item.tone)
    .clamp(copy.queue_show_more, copy.queue_show_less)
    .on_edit(edit_label, move |_, _, cx| {
        load_queued_into_composer(&record, cx);
    })
    .on_delete(delete_label, move |_, _, cx| delete(&record_id, cx));
    if entering {
        row = row.entering();
    }
    if item.can_send_now {
        let (record_id, key, state) = (item.record.id.clone(), item.key.clone(), state.clone());
        row = row.send_now(copy.send_now, None, move |_, window, cx| {
            send_now(&record_id, &key, &state, window, cx);
        });
    }
    row
}

/// `deleteQueuedMessage`: the agent drops the record, then the Store refreshes the queue.
fn delete(record_id: &str, cx: &mut App) {
    let done = request(cx, Op::Delete(record_id.to_owned()));
    cx.spawn(async move |cx| {
        done.await;
        cx.update(queue_changed);
    })
    .detach();
}

/// `sendNow`: marks the key pending (the row shows "sending") until the agent drops the
/// record; a refused request releases it and shows the error.
fn send_now(
    record_id: &str,
    key: &str,
    state: &Entity<QueueState>,
    window: &mut Window,
    cx: &mut App,
) {
    if !state.update(cx, |state, _| state.pending.insert(key.to_owned())) {
        return;
    }
    window.refresh();
    let done = request(cx, Op::SendNow(record_id.to_owned()));
    let failed = Media::get(cx).send_now_failed;
    let (key, state) = (key.to_owned(), state.clone());
    cx.spawn(async move |cx| {
        let accepted = done.await;
        if !accepted {
            let _ = state.update(cx, |state, cx| {
                state.pending.remove(&key);
                cx.notify();
            });
        }
        cx.update(|cx| {
            if !accepted {
                toast::show(cx, Toast::error(failed));
            }
            queue_changed(cx);
        });
    })
    .detach();
}

/// Queued messages in the transcript (edit, delete, send now).
pub(crate) fn queued_rows(
    queue: &SessionQueueView,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let chat_id = t.view.session_id.as_str();
    let state = window.use_keyed_state(
        SharedString::from(format!("queued-state-{chat_id}")),
        cx,
        |_, _| QueueState::default(),
    );
    let shown: HashSet<&str> = t.view.messages.iter().map(|m| m.id.as_str()).collect();
    let sending = state.read(cx).pending.clone();
    let items = queued_conversation_items(queue, chat_id, &shown, &sending);
    let keys: Vec<String> = items.iter().map(|item| item.key.clone()).collect();
    let entering = state.update(cx, |state, _| {
        state.observe(&keys);
        state.entering.clone()
    });
    div()
        .flex()
        .flex_col()
        .children(
            items
                .iter()
                .map(|item| queued_message_item(item, entering.contains(&item.key), &state, lang)),
        )
        .into_any_element()
}
