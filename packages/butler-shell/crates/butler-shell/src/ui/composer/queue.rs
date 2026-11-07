//! Send while running → `/session-queue` (queue/steer): `queueMessage`, `useComposerQueue`.
#![allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

use butler_ds::ui::context::Lang;
use butler_shell_client::{Error, ShellClient};
use gpui::{App, Global};
use serde_json::{Value, json};

use super::state::{ComposerAttachment, ComposerControls, ComposerState};
use crate::ui::source::wire::{
    AccessMode, MessageContent, MessageContentPart, ProjectSourceReferenceKind,
    QueuedMessageRecord, ReasoningEffort, SessionQueueView,
};

/// `appCopy.interfaceFeedback.queueFailed`
pub(crate) fn queue_failed_label(lang: Lang) -> &'static str {
    match lang {
        Lang::Ko => "메시지 대기열 추가 실패",
        Lang::En => "Message queue failed",
    }
}

fn effort_wire(effort: &ReasoningEffort) -> Option<&'static str> {
    match effort {
        ReasoningEffort::None => Some("none"),
        ReasoningEffort::Low => Some("low"),
        ReasoningEffort::Medium => Some("medium"),
        ReasoningEffort::High => Some("high"),
        ReasoningEffort::Xhigh => Some("xhigh"),
        ReasoningEffort::Max => Some("max"),
        ReasoningEffort::Unknown => None,
    }
}

fn access_wire(mode: &AccessMode) -> Option<&'static str> {
    match mode {
        AccessMode::ReadOnly => Some("read_only"),
        AccessMode::AskFirst => Some("ask_first"),
        AccessMode::AskExceptReads => Some("ask_except_reads"),
        AccessMode::Auto => Some("auto"),
        AccessMode::FullAccess => Some("full_access"),
        AccessMode::Unknown => None,
    }
}

fn source_kind_wire(kind: &ProjectSourceReferenceKind) -> Option<&'static str> {
    match kind {
        ProjectSourceReferenceKind::Plan => Some("plan"),
        ProjectSourceReferenceKind::Task => Some("task"),
        ProjectSourceReferenceKind::Spec => Some("spec"),
        ProjectSourceReferenceKind::Report => Some("report"),
        ProjectSourceReferenceKind::Reference => Some("reference"),
        ProjectSourceReferenceKind::Message => Some("message"),
        ProjectSourceReferenceKind::Work => Some("work"),
        ProjectSourceReferenceKind::Unknown => None,
    }
}

fn part_json(part: &MessageContentPart) -> Value {
    match part {
        MessageContentPart::Text { text } => json!({ "type": "text", "text": text }),
        MessageContentPart::SessionRef {
            sessionId,
            titleSnapshot,
        } => {
            json!({ "type": "session_ref", "sessionId": sessionId, "titleSnapshot": titleSnapshot })
        }
        MessageContentPart::ProjectRef {
            projectId,
            titleSnapshot,
        } => {
            json!({ "type": "project_ref", "projectId": projectId, "titleSnapshot": titleSnapshot })
        }
        MessageContentPart::ProjectSourceRef {
            projectId,
            source,
            titleSnapshot,
            topic,
        } => json!({
            "type": "project_source_ref",
            "projectId": projectId,
            "source": {
                "kind": source_kind_wire(&source.kind),
                "id": source.id,
                "revision": source.revision,
            },
            "titleSnapshot": titleSnapshot,
            "topic": topic,
        }),
    }
}

fn content_json(content: &MessageContent) -> Value {
    json!({
        "version": content.version,
        "parts": content.parts.iter().map(part_json).collect::<Vec<_>>(),
        "attachment_metadata": content.attachment_metadata,
    })
}

/// The `POST /session-queue` body (`queueMessage`).
fn queue_body(chat_id: &str, text: &str, controls: &ComposerControls) -> Value {
    json!({
        "chat_id": chat_id,
        "text": text,
        "model": controls.model,
        "content_parts": controls.content_parts.as_ref().map(content_json),
        "reasoning_effort": controls.reasoning_effort.as_ref().and_then(effort_wire),
        "access_mode": controls.access_mode.as_ref().and_then(access_wire),
        "plan_mode": controls.plan_mode,
        "attachments": controls
            .attachments
            .iter()
            .map(|attachment| json!({ "file_id": attachment.file_id }))
            .collect::<Vec<_>>(),
    })
}

/// `queueMessage` for a started chat: the queue after the message was added. The caller shows
/// `queue_failed_label` on an error and runs `onAccepted` / `onRejected` of the submission. A
/// draft chat sends instead of queueing (the caller's `sendMessage`).
pub(crate) async fn queue_message(
    client: &ShellClient,
    chat_id: &str,
    text: &str,
    controls: &ComposerControls,
) -> Result<SessionQueueView, Error> {
    // TODO(integration: run on agent worker)
    let value = client
        .queue_message(&queue_body(chat_id, text, controls))
        .await?;
    serde_json::from_value(value).map_err(|_| Error::Protocol)
}

type DeleteHandler = Rc<dyn Fn(&str, &mut App)>;

#[derive(Default)]
struct DeleteQueued(Option<DeleteHandler>);

impl Global for DeleteQueued {}

/// Registers what deletes a queued message (`deleteQueuedMessage`, a `ShellClient` call the
/// shell runs on the agent worker).
pub(crate) fn on_delete_queued(cx: &mut App, handler: impl Fn(&str, &mut App) + 'static) {
    cx.default_global::<DeleteQueued>().0 = Some(Rc::new(handler));
}

static QUEUED_ATTACHMENTS: AtomicU64 = AtomicU64::new(0);

/// `loadQueuedMessageIntoComposer`: edit a queued (or failed) message. Its text, content parts
/// and attachments become the composer's, it leaves the queue, and the editor takes focus.
pub(crate) fn load_queued_into_composer(record: &QueuedMessageRecord, cx: &mut App) {
    ComposerState::update(cx, |composer| {
        match record.content_parts.clone() {
            Some(content) => composer.set_content_parts(content),
            None => composer.set_text(&record.text),
        }
        composer.attachments = (record.attachments.iter().flatten())
            .map(|file| ComposerAttachment {
                id: format!(
                    "queued-{}-{}",
                    file.file_id,
                    QUEUED_ATTACHMENTS.fetch_add(1, Ordering::Relaxed)
                ),
                file: file.clone(),
                kind: file.kind.clone(),
            })
            .collect();
        composer.request_focus();
    });
    let handler = cx
        .try_global::<DeleteQueued>()
        .and_then(|deleter| deleter.0.clone());
    if let Some(delete) = handler {
        delete(&record.id, cx);
    }
}
