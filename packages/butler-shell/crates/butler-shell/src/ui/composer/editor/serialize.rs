//! `serialization.ts`: parts ↔ the send body's text and content parts.
use serde_json::{Value, json};

use super::{Atom, ComposerPart};
use crate::ui::source::wire::{
    MessageContent, MessageContentPart, ProjectSourceContentPart, ProjectSourceReferenceKind,
};

/// `appendPart`: text runs merge and empty text is dropped.
pub(crate) fn append_part(parts: &mut Vec<ComposerPart>, part: ComposerPart) {
    match (parts.last_mut(), part) {
        (Some(ComposerPart::Text(last)), ComposerPart::Text(text)) => last.push_str(&text),
        (_, ComposerPart::Text(text)) if text.is_empty() => {}
        (_, part) => parts.push(part),
    }
}

fn kind_name(kind: &ProjectSourceReferenceKind) -> &'static str {
    match kind {
        ProjectSourceReferenceKind::Plan => "plan",
        ProjectSourceReferenceKind::Task => "task",
        ProjectSourceReferenceKind::Spec => "spec",
        ProjectSourceReferenceKind::Report => "report",
        ProjectSourceReferenceKind::Message => "message",
        ProjectSourceReferenceKind::Work => "work",
        ProjectSourceReferenceKind::Reference | ProjectSourceReferenceKind::Unknown => "reference",
    }
}

/// `$nodesForContent`, one part: the editor part a wire content part stands for.
fn part_from_wire(part: &MessageContentPart) -> ComposerPart {
    match part {
        MessageContentPart::Text { text } => ComposerPart::Text(text.clone()),
        MessageContentPart::SessionRef {
            sessionId,
            titleSnapshot,
        } => ComposerPart::Atom(Atom::Session {
            id: sessionId.clone(),
            label: titleSnapshot.clone().into(),
        }),
        MessageContentPart::ProjectRef {
            projectId,
            titleSnapshot,
        } => ComposerPart::Atom(Atom::Project {
            id: projectId.clone(),
            label: titleSnapshot.clone().into(),
        }),
        MessageContentPart::ProjectSourceRef {
            projectId,
            source,
            titleSnapshot,
            topic,
        } => ComposerPart::Atom(Atom::ProjectSource {
            id: source.id.clone(),
            label: titleSnapshot.clone().into(),
            part: ProjectSourceContentPart {
                r#type: "project_source_ref".to_owned(),
                projectId: projectId.clone(),
                source: source.clone(),
                titleSnapshot: titleSnapshot.clone(),
                topic: topic.clone(),
            },
        }),
    }
}

/// `$nodesForContent`: the editor parts of stored content.
pub(crate) fn parts_from_content(content: &MessageContent) -> Vec<ComposerPart> {
    let mut parts = Vec::new();
    for part in &content.parts {
        append_part(&mut parts, part_from_wire(part));
    }
    parts
}

/// `storeDraft`: the draft's content parts, or its text as one part.
pub(crate) fn draft_parts(content: Option<&MessageContent>, text: &str) -> Vec<ComposerPart> {
    match content {
        Some(content) => parts_from_content(content),
        None if text.is_empty() => Vec::new(),
        None => vec![ComposerPart::Text(text.to_owned())],
    }
}

/// `$readComposerContent`'s part for one editor part, in the wire's JSON shape.
fn part_json(part: &ComposerPart) -> Value {
    match part {
        ComposerPart::Text(text) => json!({ "type": "text", "text": text }),
        ComposerPart::Atom(Atom::Session { id, label }) => {
            json!({ "type": "session_ref", "sessionId": id, "titleSnapshot": label.to_string() })
        }
        ComposerPart::Atom(Atom::Project { id, label }) => {
            json!({ "type": "project_ref", "projectId": id, "titleSnapshot": label.to_string() })
        }
        ComposerPart::Atom(Atom::ProjectSource { part, .. }) => {
            let mut reference = json!({
                "type": "project_source_ref",
                "projectId": part.projectId,
                "source": {
                    "kind": kind_name(&part.source.kind),
                    "id": part.source.id,
                    "revision": part.source.revision,
                },
                "titleSnapshot": part.titleSnapshot,
            });
            if let (Some(topic), Some(object)) = (&part.topic, reference.as_object_mut()) {
                object.insert("topic".to_owned(), json!(topic));
            }
            reference
        }
    }
}

/// The send body's `content_parts`: `{ version: 1, parts }`.
pub(crate) fn content_json(parts: &[ComposerPart]) -> Value {
    json!({ "version": 1, "parts": parts.iter().map(part_json).collect::<Vec<_>>() })
}

/// `messageContentText`: text as written, each atom as `@title`.
pub(crate) fn content_text(parts: &[ComposerPart]) -> String {
    parts
        .iter()
        .map(|part| match part {
            ComposerPart::Text(text) => text.clone(),
            ComposerPart::Atom(
                Atom::Project { label, .. }
                | Atom::Session { label, .. }
                | Atom::ProjectSource { label, .. },
            ) => format!("@{label}"),
        })
        .collect()
}

/// Whether `parts` holds anything but text (a draft then keeps its content parts).
pub(crate) fn has_atoms(parts: &[ComposerPart]) -> bool {
    parts
        .iter()
        .any(|part| matches!(part, ComposerPart::Atom(_)))
}

/// `isMessageContent`, then the editor parts: `None` for anything that is not message content.
pub(crate) fn parse_content(raw: &str) -> Option<Vec<ComposerPart>> {
    let content: MessageContent = serde_json::from_str(raw).ok()?;
    let valid = content.version == 1
        && content.parts.len() <= 1000
        && content.parts.iter().all(|part| match part {
            MessageContentPart::Text { .. } => true,
            MessageContentPart::SessionRef { sessionId, .. } => !sessionId.trim().is_empty(),
            MessageContentPart::ProjectRef {
                projectId,
                titleSnapshot,
            } => {
                !projectId.trim().is_empty()
                    && projectId.chars().count() <= 256
                    && titleSnapshot.chars().count() <= 500
            }
            MessageContentPart::ProjectSourceRef {
                projectId,
                titleSnapshot,
                ..
            } => {
                !projectId.is_empty()
                    && projectId.chars().count() <= 256
                    && titleSnapshot.chars().count() <= 500
            }
        });
    valid.then(|| parts_from_content(&content))
}
