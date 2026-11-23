use std::{collections::HashMap, sync::Arc};

use butler_ds::ui::blocks::attachment_list::{
    AttachmentItem, AttachmentList, ThumbnailFit, Variant,
};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::ShellClient;
use gpui::{
    AnyElement, App, Global, Image, ImageSource, IntoElement as _, ParentElement as _,
    SharedString, div,
};
use serde_json::{Value, json};

use super::attachments::upload_bytes;
use super::state::{ComposerAttachment, ComposerState, Submission};
use crate::ui::browser::pick::words;
use crate::ui::manage::library::main::media::base64;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    MessageContent, MessageContentPart, MessageFileKind, MessageFileRef,
};
use crate::ui::widgets::anchor;

/// `ElementAttachment` (shared/browser-element.ts) with the picture of its uploaded crop.
#[derive(Clone)]
pub(crate) struct ElementAttachment {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) site: String,
    pub(crate) file: MessageFileRef,
    /// Sent as the file's `attachment_metadata`; `Null` sends none (`captureContent`).
    pub(crate) metadata: Value,
    pub(crate) preview: Option<Arc<Image>>,
}

impl ElementAttachment {
    /// The send gate and the image policy count it as an attachment (`useComposerState.ts:37,64`).
    pub(crate) fn attachment(&self) -> ComposerAttachment {
        ComposerAttachment {
            id: self.id.clone(),
            file: self.file.clone(),
            kind: self.file.kind.clone(),
        }
    }
}

/// `useElementDraft` with every session's `element_attachments`, in memory as `store/drafts.rs` keeps drafts.
#[derive(Default)]
pub(super) struct Drafts(HashMap<String, Vec<ElementAttachment>>);

impl Global for Drafts {}

pub(crate) fn draft_key(cx: &mut App) -> String {
    ComposerState::read(cx, |d| d.draft_session_id.clone())
}

pub(crate) fn items(session: &str, cx: &App) -> Vec<ElementAttachment> {
    cx.try_global::<Drafts>()
        .and_then(|drafts| drafts.0.get(session))
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn current(cx: &mut App) -> Vec<ElementAttachment> {
    let session = draft_key(cx);
    items(&session, cx)
}

fn change(session: &str, cx: &mut App, edit: impl FnOnce(&mut Vec<ElementAttachment>)) {
    edit(
        cx.default_global::<Drafts>()
            .0
            .entry(session.to_owned())
            .or_default(),
    );
}

pub(crate) fn attach(session: String, elements: Vec<Value>, cx: &mut App) {
    // Only a chat's own key is a session id; `draft:chat` and `dashboard:<project>`
    // upload unscoped, as the composer's files do.
    let scope = (!session.contains(':')).then(|| session.clone());
    let uploads = Jobs::run(cx, move |client| async move {
        upload(&client, scope.as_deref(), elements).await
    });
    cx.spawn(async move |cx| {
        let uploaded = uploads.await.and_then(Result::ok);
        cx.update(|cx| match uploaded {
            Some(items) => change(&session, cx, |list| {
                list.retain(|old| !items.iter().any(|new| new.id == old.id));
                list.extend(items);
            }),
            None => {
                toast::show(cx, Toast::error(words(cx).failed));
            }
        });
    })
    .detach();
}

async fn upload(
    client: &ShellClient,
    session: Option<&str>,
    elements: Vec<Value>,
) -> Result<Vec<ElementAttachment>, ()> {
    let mut items = Vec::new();
    for element in elements {
        let bytes = element["crop"]
            .as_str()
            .and_then(|u| u.strip_prefix("data:image/jpeg;base64,"))
            .and_then(base64)
            .ok_or(())?;
        let (file, preview) =
            upload_bytes(client, session, "element.jpg", "image/jpeg", bytes).await?;
        items.push(ElementAttachment {
            id: element["id"].as_str().unwrap_or_default().to_owned(),
            title: element["title"].as_str().unwrap_or_default().to_owned(),
            site: element["site"].as_str().unwrap_or_default().to_owned(),
            file,
            metadata: metadata(&element),
            preview,
        });
    }
    Ok(items)
}

fn metadata(element: &Value) -> Value {
    let mut source = element.as_object().cloned().unwrap_or_default();
    source.remove("crop");
    source.remove("ref");
    source.remove("observation");
    source
        .entry("kind")
        .or_insert_with(|| json!("untrusted_web_page_data"));
    json!({"untrusted_content": source})
}

pub(crate) fn remove(session: &str, id: &str, cx: &mut App) {
    change(session, cx, |l| l.retain(|i| i.id != id));
}

pub(crate) fn sent(submission: &Submission, cx: &mut App) {
    let (session, sent) = submission.elements();
    if sent.is_empty() {
        return;
    }
    change(session, cx, |l| {
        l.retain(|i| !sent.iter().any(|s| s.id == i.id))
    });
}

/// A rejected send keeps its elements; Electron clears them only once accepted.
pub(crate) fn restore(submission: &Submission, cx: &mut App) {
    let (session, sent) = submission.elements();
    if sent.is_empty() {
        return;
    }
    change(session, cx, |l| {
        l.retain(|i| !sent.iter().any(|s| s.id == i.id));
        l.splice(0..0, sent.iter().cloned());
    });
}

pub(crate) fn capture_content(
    content: Option<MessageContent>,
    text: &str,
    elements: &[ElementAttachment],
) -> Option<MessageContent> {
    let captures: Vec<_> = elements
        .iter()
        .filter(|e| e.file.kind == MessageFileKind::Image && !e.metadata.is_null())
        .collect();
    if captures.is_empty() {
        return content;
    }
    let mut content = content.unwrap_or_else(|| MessageContent {
        version: 1,
        parts: vec![MessageContentPart::Text {
            text: text.to_owned(),
        }],
        attachment_metadata: None,
    });
    let mut metadata = content
        .attachment_metadata
        .take()
        .and_then(|value| match value {
            Value::Object(metadata) => Some(metadata),
            _ => None,
        })
        .unwrap_or_default();
    for item in captures {
        metadata.insert(item.file.file_id.clone(), item.metadata.clone());
    }
    content.attachment_metadata = Some(Value::Object(metadata));
    Some(content)
}

pub(super) fn chips(blocked: &HashMap<String, SharedString>, cx: &mut App) -> Option<AnyElement> {
    let session = draft_key(cx);
    let picked = items(&session, cx);
    if picked.is_empty() {
        return None;
    }
    let rows = picked
        .iter()
        .map(|item| {
            let row =
                AttachmentItem::new(item.id.clone(), item.title.clone()).meta(item.site.clone());
            let row = if let Some(reason) = blocked.get(&item.id) {
                row.blocked(reason.clone())
            } else {
                row.element(item.site.clone())
            };
            if let Some(preview) = &item.preview {
                row.thumbnail(ImageSource::Image(preview.clone()), ThumbnailFit::Contain)
            } else {
                row
            }
        })
        .collect();
    let label = words(cx).remove;
    let list = AttachmentList::new("composer-elements", rows)
        .variant(Variant::Chips)
        .remove_label(move |_| label.to_owned())
        .on_remove(move |id, _, cx| remove(&session, id, cx));
    Some(
        anchor(div(), "composer-elements")
            .child(list)
            .into_any_element(),
    )
}
