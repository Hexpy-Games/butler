//! `QueuedMessageItem`, `queuedConversationItems`, the queue hooks.
use std::collections::HashSet;

use butler_ds::ui::blocks::queued_message::{QueuedMessage, QueuedTone};
use butler_ds::ui::context::{Ds, Lang};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div,
};

use super::TranscriptCtx;
use crate::ui::source::wire::{QueuedMessageRecord, QueuedMessageRecordState, SessionQueueView};

/// The composer strings of `appCopy.composer` and `conversation.messageActions` the rows use.
struct Strings {
    queued_message: &'static str,
    sending_status: &'static str,
    failed_message_status: &'static str,
    queued_message_status: &'static str,
    edit_queued_message: &'static str,
    delete_queued_message: &'static str,
    retry_failed_message: &'static str,
    delete_failed_message: &'static str,
    send_now: &'static str,
    show_more: &'static str,
    show_less: &'static str,
}

const EN: Strings = Strings {
    queued_message: "Queued message",
    sending_status: "Sending…",
    failed_message_status: "Send failed",
    queued_message_status: "Queued",
    edit_queued_message: "Edit queued message",
    delete_queued_message: "Delete queued message",
    retry_failed_message: "Retry message",
    delete_failed_message: "Delete failed message",
    send_now: "Send now",
    show_more: "Show more",
    show_less: "Show less",
};

const KO: Strings = Strings {
    queued_message: "대기 중인 메시지",
    sending_status: "보내는 중…",
    failed_message_status: "전송 실패",
    queued_message_status: "대기 중",
    edit_queued_message: "대기 메시지 수정",
    delete_queued_message: "대기 메시지 삭제",
    retry_failed_message: "다시 작성",
    delete_failed_message: "실패 메시지 삭제",
    send_now: "지금 보내기",
    show_more: "더보기",
    show_less: "접기",
};

/// `composer.queuedPosition`
fn queued_position(lang: Lang, position: usize, total: usize) -> String {
    match lang {
        Lang::Ko => format!("대기 중 · {total}개 중 {position}번째"),
        Lang::En => format!("Queued · {position} of {total}"),
    }
}

/// `composer.queuedAttachmentCount`
fn queued_attachment_count(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Ko => format!("첨부 {count}개"),
        Lang::En => format!("{count} attachments"),
    }
}

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

/// Runs the route on its own runtime (the client needs tokio's reactor, gpui's executor has
/// none); true when the agent accepted it.
async fn request(client: ShellClient, op: Op) -> bool {
    let (send, receive) = oneshot::channel();
    std::thread::spawn(move || {
        let ok = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .is_ok_and(|runtime| {
                runtime.block_on(async move {
                    match op {
                        Op::Delete(id) => client.delete_queued_message(&id).await.is_ok(),
                        Op::SendNow(id) => client.send_queued_message_now(&id).await.is_ok(),
                    }
                })
            });
        let _ = send.send(ok);
    });
    receive.await.unwrap_or(false)
}

/// `queuedStatus`
fn queued_status(item: &Item, lang: Lang, copy: &Strings) -> String {
    match item.tone {
        QueuedTone::Sending => copy.sending_status.to_owned(),
        QueuedTone::Failed => copy.failed_message_status.to_owned(),
        QueuedTone::Queued if item.total > 1 => queued_position(lang, item.position, item.total),
        QueuedTone::Queued => copy.queued_message_status.to_owned(),
    }
}

/// `queuedText`
fn queued_text(record: &QueuedMessageRecord, lang: Lang, copy: &Strings) -> String {
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
            queued_attachment_count(lang, attachments.len())
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
    client: Option<&ShellClient>,
    lang: Lang,
) -> QueuedMessage {
    let copy = if lang == Lang::Ko { &KO } else { &EN };
    let failed = item.tone == QueuedTone::Failed;
    let id = SharedString::from(format!("queued-{}", item.key));
    let mut row = QueuedMessage::new(
        id,
        queued_text(item.record, lang, copy),
        queued_status(item, lang, copy),
    )
    .tone(item.tone)
    .clamp(copy.show_more, copy.show_less)
    // `onEdit` loads the record into the composer (`loadQueuedMessageIntoComposer`); the
    // composer has no entry for it in the shell yet.
    .on_edit(
        if failed {
            copy.retry_failed_message
        } else {
            copy.edit_queued_message
        },
        |_, _, _| {},
    )
    .on_delete(
        if failed {
            copy.delete_failed_message
        } else {
            copy.delete_queued_message
        },
        {
            let (client, record_id) = (client.cloned(), item.record.id.clone());
            move |_, _, cx| {
                if let Some(client) = client.clone() {
                    let record_id = record_id.clone();
                    cx.spawn(async move |_| {
                        request(client, Op::Delete(record_id)).await;
                    })
                    .detach();
                }
            }
        },
    );
    if entering {
        row = row.entering();
    }
    if item.can_send_now {
        let (client, record_id, key, state) = (
            client.cloned(),
            item.record.id.clone(),
            item.key.clone(),
            state.clone(),
        );
        row = row.send_now(copy.send_now, None, move |_, window, cx| {
            send_now(client.clone(), &record_id, &key, &state, window, cx);
        });
    }
    row
}

/// `sendNow`: marks the key pending (the row shows "sending") until the agent drops the
/// record; a refused request releases it.
fn send_now(
    client: Option<ShellClient>,
    record_id: &str,
    key: &str,
    state: &Entity<QueueState>,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(client) = client else { return };
    if !state.update(cx, |state, _| state.pending.insert(key.to_owned())) {
        return;
    }
    window.refresh();
    let (record_id, key, state) = (record_id.to_owned(), key.to_owned(), state.clone());
    cx.spawn(async move |cx| {
        if !request(client, Op::SendNow(record_id)).await {
            let _ = state.update(cx, |state, cx| {
                state.pending.remove(&key);
                cx.notify();
            });
        }
    })
    .detach();
}

/// Queued messages in the transcript (edit, delete, send now).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
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
        .children(items.iter().map(|item| {
            queued_message_item(
                item,
                entering.contains(&item.key),
                &state,
                t.client.as_ref(),
                lang,
            )
        }))
        .into_any_element()
}
