//! `MessageArtifacts`, `MessageAttachments`, `MessageChanged*`, `MessageGeneratedFileRow`,
//! `WorkingFileMenu`, `messageImages`, `messageMedia`, `useMessageFileSource`.
//!
//! An assistant message shows its delivered files (`MessageArtifacts`) and the files its turn
//! changed (`MessageChangedFiles`); any other message shows its attachments as tiles
//! (`MessageAttachments`). The signed-URL refresh of `useMessageFileSource` is not needed here:
//! the shell's client is authorized, so a file loads by its id.
mod changed;
mod media;
mod support;

use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::artifact_list::{ArtifactAction, ArtifactItem, ArtifactList};
use butler_ds::ui::blocks::attachment_list::{
    AttachmentItem, AttachmentList, ThumbnailFit, TileLayout, Variant,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
};

use self::changed::changed_files;
use self::media::{Artifact, ViewerSet, format_size, inline_image_files, is_legacy};
use self::support::{open_viewer, picture, save_file, tr};
use super::TranscriptCtx;
use super::message_markdown::message_markdown;
use crate::ui::source::wire::{MessageFileKind, MessageRecord, MessageRecordRole};

/// A message's artifacts, attachments and changed files; `None` when it has none.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) fn message_files(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let set = Rc::new(ViewerSet::of(msg));
    let parts: Vec<AnyElement> = if msg.role == MessageRecordRole::Assistant {
        let bubble = msg.chat_id.as_deref() == Some("general");
        [
            artifacts(msg, t, &set, bubble, cx),
            changed_files(msg, t, &set, bubble, window, cx),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else {
        attachments(msg, t, &set, cx).into_iter().collect()
    };
    if parts.is_empty() {
        return None;
    }
    Some(div().flex().flex_col().children(parts).into_any_element())
}

/// `MessageArtifacts`: the delivered files, pictures inline and the rest in a list.
fn artifacts(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    set: &Rc<ViewerSet>,
    bubble: bool,
    cx: &mut App,
) -> Option<AnyElement> {
    let attachments = msg.attachments.as_deref().unwrap_or_default();
    let summaries = msg.artifacts.as_deref().unwrap_or_default();
    let inline = inline_image_files(&msg.text, attachments);
    let legacy = is_legacy(attachments);
    // Only delivered files are listed here; the rest of the turn's files stay in the
    // changed-files block.
    let source: Vec<Artifact> = if summaries.is_empty() {
        attachments.iter().map(Artifact::of_file).collect()
    } else {
        summaries.iter().map(Artifact::of_summary).collect()
    };
    let visible: Vec<Artifact> = source
        .into_iter()
        .filter(|artifact| legacy || artifact.deliverable)
        .filter(|artifact| {
            !artifact.is_image
                || artifact
                    .url
                    .as_ref()
                    .is_none_or(|url| !inline.contains(url))
        })
        .collect();
    let (images, files): (Vec<Artifact>, Vec<Artifact>) = visible
        .into_iter()
        .partition(|artifact| artifact.is_image && artifact.url.is_some());
    let work_link = work_link_row(msg, cx);
    if images.is_empty() && files.is_empty() && work_link.is_none() {
        return None;
    }
    let mut stack = Stack::new().gap(if bubble { Space::Lg } else { Space::Md });
    for artifact in &images {
        stack = stack.child(artifact_image(artifact, msg, set, cx));
    }
    if !files.is_empty() || work_link.is_some() {
        let mut list =
            ArtifactList::new(SharedString::from(format!("message-artifacts-{}", msg.id)));
        for artifact in &files {
            list = list.item(artifact_item(artifact, t, cx));
        }
        if let Some(item) = work_link {
            list = list.item(item);
        }
        stack = stack.child(list);
    }
    let spacer = (!bubble).then(|| div().h(Space::Md.px(Ds::get(cx))));
    Some(
        div()
            .flex()
            .flex_col()
            .children(spacer)
            .child(stack)
            .into_any_element(),
    )
}

/// The row that views the work an `initiated` message came from.
fn work_link_row(msg: &MessageRecord, cx: &App) -> Option<ArtifactItem> {
    let origin = msg.initiated.as_ref()?;
    if origin.kind != "work_result" && origin.kind != "work_failed" {
        return None;
    }
    origin.work_session_id.as_ref()?;
    Some(
        ArtifactItem::new(origin.work_title.clone().unwrap_or_default())
            .description(tr(cx, "View work", "작업 보기"))
            .icon(Icon::Eye),
    )
}

/// One file of the list: its name and size over a Save action.
fn artifact_item(artifact: &Artifact, t: &TranscriptCtx, cx: &App) -> ArtifactItem {
    let mut item = ArtifactItem::new(artifact.title.clone()).icon(Icon::FileText);
    if let Some(bytes) = artifact.size_bytes {
        item = item.description(format_size(bytes, false));
    }
    let Some(file_id) = artifact.file_id.clone() else {
        return item;
    };
    let (name, client) = (artifact.file_name(), t.client.clone());
    item.action(
        ArtifactAction::new(tr(cx, "Save", "저장하기"))
            .icon(Icon::Save)
            .on_click(move |_, _, cx| save_file(file_id.clone(), name.clone(), client.clone(), cx)),
    )
}

/// A delivered picture: shown as Markdown shows an image, and opening the viewer on click.
fn artifact_image(
    artifact: &Artifact,
    msg: &MessageRecord,
    set: &Rc<ViewerSet>,
    cx: &mut App,
) -> AnyElement {
    let url = artifact.url.clone().unwrap_or_default();
    let alt = artifact.title.replace('[', "\\[").replace(']', "\\]");
    let id = SharedString::from(format!("message-image-{}-{}", msg.id, artifact.title));
    let markdown = message_markdown(
        ElementId::from(id.clone()),
        format!("![{alt}]({url})").into(),
        false,
        cx,
    );
    let (set, key) = (set.clone(), url);
    div()
        .id(id)
        .cursor_pointer()
        .on_click(move |_, _, cx| {
            if let Some(index) = set.index_of(&key) {
                open_viewer(set.images.clone(), index, cx);
            }
        })
        .child(markdown)
        .into_any_element()
}

/// The type label of a tile: the name's extension in capitals, or "File".
fn attachment_extension(name: &str, cx: &App) -> SharedString {
    let name = name.trim();
    match name.rsplit_once('.') {
        Some((_, ext))
            if (1..=5).contains(&ext.chars().count()) && ext.chars().all(char::is_alphanumeric) =>
        {
            ext.to_uppercase().into()
        }
        _ => tr(cx, "File", "파일").into(),
    }
}

/// `MessageAttachments`: a message's files as tiles; pictures open the image viewer.
fn attachments(
    msg: &MessageRecord,
    t: &TranscriptCtx,
    set: &Rc<ViewerSet>,
    cx: &mut App,
) -> Option<AnyElement> {
    let files = msg.attachments.as_deref().unwrap_or_default();
    if files.is_empty() {
        return None;
    }
    let metadata = msg
        .content_parts
        .as_ref()
        .and_then(|parts| parts.attachment_metadata.as_ref());
    let mut items = Vec::with_capacity(files.len());
    for file in files {
        let mut item = AttachmentItem::new(file.file_id.clone(), file.safe_name.clone())
            .meta(format_size(file.size_bytes, true))
            .extension(attachment_extension(&file.safe_name, cx));
        if file.kind == MessageFileKind::Image
            && let Some(source) = picture(&file.file_id, t.client.as_ref(), cx)
        {
            let capture =
                metadata.is_some_and(|m| m.get(&file.file_id).is_some_and(|v| !v.is_null()));
            let fit = if capture {
                ThumbnailFit::Contain
            } else {
                ThumbnailFit::Cover
            };
            item = item.thumbnail(source, fit);
        }
        items.push(item);
    }
    let pictures: Vec<(String, String)> = files
        .iter()
        .filter(|file| file.kind == MessageFileKind::Image)
        .map(|file| (file.file_id.clone(), file.url.clone()))
        .collect();
    let set = set.clone();
    let list = AttachmentList::new(
        SharedString::from(format!("message-attachments-{}", msg.id)),
        items,
    )
    .variant(Variant::Tiles)
    .tile_layout(TileLayout::Wrap)
    .on_open(move |id, _, cx| {
        let Some((_, url)) = pictures
            .iter()
            .find(|(file_id, _)| file_id.as_str() == &**id)
        else {
            return;
        };
        if let Some(index) = set.index_of(url) {
            open_viewer(set.images.clone(), index, cx);
        }
    });
    Some(list.into_any_element())
}
