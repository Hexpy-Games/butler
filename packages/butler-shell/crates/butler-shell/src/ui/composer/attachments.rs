//! `ComposerAttachments`, `attachmentTiles`, `useFileAttachments`, `useComposerFileDrop`,
//! `usePendingProjectDocumentAttachment`, `ComposerElements`; the attachment menu and the
//! project-document picker are in `menu` and `documents`.
//!
//! The composer's state (`composer::state`) holds an [`Attachments`] and calls the upload
//! futures here; each future runs on the agent worker (`TODO(integration)` at its definition)
//! and is applied with the epoch it began under, so a chat change drops its result as React's
//! `uploadEpochRef` does.
#![allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
pub(crate) mod documents;
pub(crate) mod menu;

use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::attachment_list::{
    AttachmentItem, AttachmentList, ThumbnailFit, TileLayout, Variant,
};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::Toast;
use butler_shell_client::{ShellClient, Upload};
use gpui::{
    AnyElement, App, BorrowAppContext as _, ExternalPaths, Image, ImageFormat, ImageSource,
    InteractiveElement, IntoElement as _, ParentElement as _, SharedString, Styled as _, Task,
    Window, div,
};

use self::documents::tr;
use super::state::ComposerAttachment;
use crate::ui::shell::image_viewer::{ImageViewerHost, ViewerImage};
use crate::ui::source::wire::{MessageFileKind, MessageFileRef, ProjectDashboardDocument};

/// `ATTACHMENT_MAX_BYTES` (`conversationUtils.ts`).
pub(crate) const ATTACHMENT_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// `browserRandomUUID` stand-in: ids stay unique within the run.
fn next_serial() -> u64 {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    SERIAL.fetch_add(1, Ordering::Relaxed)
}

/// What the tile shows beyond `ComposerAttachment`: the project-document glyph and the picture
/// of an image (from the bytes that were uploaded).
#[derive(Clone, Default)]
pub(crate) struct Extra {
    pub(crate) project_document: bool,
    pub(crate) preview: Option<ImageSource>,
}

/// An uploaded file with its [`Extra`].
pub(crate) type Uploaded = (ComposerAttachment, Extra);

/// `useFileAttachments`' epoch and the tiles' extras; the files themselves and the uploading
/// count are the composer state's (`ComposerState.attachments`, `uploading_count`).
#[derive(Default)]
pub(crate) struct Attachments {
    extras: HashMap<String, Extra>,
    epoch: Rc<Cell<u64>>,
}

impl Attachments {
    /// The epoch cell the upload futures compare against.
    pub(crate) fn epoch(&self) -> Rc<Cell<u64>> {
        self.epoch.clone()
    }

    /// The epoch an upload that starts now runs under.
    pub(crate) fn started(&self) -> u64 {
        self.epoch.get()
    }

    /// The effect on `activeChatId` (and unmount): drops any upload in flight and the extras.
    pub(crate) fn reset(&mut self) {
        self.epoch.set(self.epoch.get() + 1);
        self.extras.clear();
    }

    /// `removeAttachment`.
    pub(crate) fn remove(&mut self, id: &str) {
        self.extras.remove(id);
    }

    /// Finished uploads: the files to add to the state, or none when the chat changed since
    /// `started`.
    pub(crate) fn accept(&mut self, started: u64, files: Vec<Uploaded>) -> Vec<ComposerAttachment> {
        if self.epoch.get() != started {
            return Vec::new();
        }
        files
            .into_iter()
            .map(|(attachment, extra)| {
                self.extras.insert(attachment.id.clone(), extra);
                attachment
            })
            .collect()
    }
}

/// A file chosen in the picker or dropped, not yet read.
#[derive(Clone, Debug)]
pub(crate) struct PickedFile {
    pub(crate) path: PathBuf,
    pub(crate) name: String,
    pub(crate) mime_type: String,
    pub(crate) size: u64,
}

impl PickedFile {
    /// A regular file at `path`; `None` for anything else.
    pub(crate) fn from_path(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        Some(Self {
            mime_type: mime_of(&name).to_owned(),
            path: path.to_owned(),
            name,
            size: metadata.len(),
        })
    }

    /// Whether the file is a picture the gateway admits (`isImageFile`).
    pub(crate) fn is_image(&self) -> bool {
        ImageFormat::from_mime_type(&self.mime_type).is_some()
    }
}

/// The media type of a file name (the browser's `File.type`): the gateway's image types by
/// extension, else the common text types, else binary.
fn mime_of(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map_or("", |(_, e)| e).to_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// The files at `paths` (directories and unreadable paths are left out).
pub(crate) fn picked_files(paths: &[PathBuf]) -> Vec<PickedFile> {
    paths
        .iter()
        .filter_map(|p| PickedFile::from_path(p))
        .collect()
}

/// `openAttachmentPicker`: the file dialog; `images` keeps only pictures.
pub(crate) fn pick_files(images: bool, cx: &mut App) -> Task<Vec<PickedFile>> {
    let chosen = cx.prompt_for_paths(gpui::PathPromptOptions {
        files: true,
        directories: false,
        multiple: true,
        prompt: None,
    });
    cx.spawn(async move |_| {
        let paths = chosen.await.ok().and_then(Result::ok).flatten();
        let files = picked_files(&paths.unwrap_or_default());
        files
            .into_iter()
            .filter(|file| !images || file.is_image())
            .collect()
    })
}

/// `useComposerFileDrop`: files dropped on `element` come to `on_paths`.
pub(crate) fn file_drop<E: InteractiveElement>(
    element: E,
    on_paths: impl Fn(Vec<PickedFile>, &mut Window, &mut App) + 'static,
) -> E {
    element.on_drop::<ExternalPaths>(move |dropped, window, cx| {
        let files = picked_files(dropped.paths());
        if !files.is_empty() {
            on_paths(files, window, cx);
        }
    })
}

/// `isFileDragActive`: whether files are being dragged over the window.
pub(crate) fn file_drag_active(cx: &App) -> bool {
    cx.active_drag()
        .is_some_and(|drag| drag.value.is::<ExternalPaths>())
}

/// `usePendingProjectDocumentAttachment`: the pending document once the open chat is in its
/// project; it leaves `pending`. The caller then runs `documents::add_project_document`.
pub(crate) fn take_pending_document(
    pending: &mut Option<(String, ProjectDashboardDocument)>,
    active_project_id: Option<&str>,
) -> Option<ProjectDashboardDocument> {
    let (project_id, _) = pending.as_ref()?;
    if active_project_id != Some(project_id.as_str()) {
        return None;
    }
    pending.take().map(|(_, document)| document)
}

/// What a batch of uploads came to.
#[derive(Default)]
pub(crate) struct UploadOutcome {
    pub(crate) accepted: Vec<Uploaded>,
    pub(crate) failed: Vec<String>,
    pub(crate) oversized: Vec<String>,
    pub(crate) empty: Vec<String>,
}

/// One upload: the stored file and the picture of an image.
pub(super) async fn upload_bytes(
    client: &ShellClient,
    session_id: Option<&str>,
    name: &str,
    mime_type: &str,
    bytes: Vec<u8>,
) -> Result<(MessageFileRef, Option<ImageSource>), ()> {
    let upload = Upload {
        file_name: name.to_owned(),
        content_type: mime_type.to_owned(),
        bytes,
    };
    let value = client
        .upload_message_file(session_id.unwrap_or(""), &upload)
        .await
        .map_err(|_| ())?;
    let file: MessageFileRef =
        serde_json::from_value(value.get("file").cloned().ok_or(())?).map_err(|_| ())?;
    let preview = (file.kind == MessageFileKind::Image)
        .then(|| ImageFormat::from_mime_type(mime_type))
        .flatten()
        .map(|format| ImageSource::Image(Arc::new(Image::from_bytes(format, upload.bytes))));
    Ok((file, preview))
}

/// `addFiles`' upload loop, one file at a time: empty and oversized files are set aside, the
/// rest uploaded to the chat's session (`session_id`: `None` unless the chat is server-backed).
/// The loop stops when `epoch` moves off `started`. The caller has already applied the image
/// policy (`imageRefusal`) to `files`.
// TODO(integration: run on agent worker)
pub(crate) async fn upload_files(
    client: ShellClient,
    session_id: Option<String>,
    files: Vec<PickedFile>,
    epoch: Rc<Cell<u64>>,
    started: u64,
) -> UploadOutcome {
    let mut outcome = UploadOutcome::default();
    for file in files {
        if epoch.get() != started {
            break;
        }
        if file.size == 0 {
            outcome.empty.push(file.name);
            continue;
        }
        if file.size > ATTACHMENT_MAX_BYTES {
            outcome.oversized.push(file.name);
            continue;
        }
        // Blocking read; it belongs to the agent worker this future runs on.
        let Ok(bytes) = std::fs::read(&file.path) else {
            outcome.failed.push(file.name);
            continue;
        };
        match upload_bytes(
            &client,
            session_id.as_deref(),
            &file.name,
            &file.mime_type,
            bytes,
        )
        .await
        {
            Ok((stored, preview)) => outcome.accepted.push((
                ComposerAttachment {
                    id: format!("{}-{}-{}", file.name, file.size, next_serial()),
                    kind: stored.kind.clone(),
                    file: stored,
                },
                Extra {
                    project_document: false,
                    preview,
                },
            )),
            Err(()) => outcome.failed.push(file.name),
        }
    }
    outcome
}

/// `formatFileSize`.
fn format_size(bytes: i64) -> String {
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", b / 1024.)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", b / (1024. * 1024.))
    } else {
        format!("{:.1} GB", b / (1024. * 1024. * 1024.))
    }
}

/// `attachmentExtension`: the name's extension in capitals (1-5 letters or digits), or "File".
fn extension(name: &str, cx: &App) -> String {
    name.trim()
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| {
            (1..=5).contains(&ext.chars().count()) && ext.chars().all(char::is_alphanumeric)
        })
        .map_or_else(|| tr(cx, "File", "파일").to_owned(), str::to_uppercase)
}

/// The notices of a finished batch (`addFiles`' tail), as toasts.
pub(crate) fn upload_notices(outcome: &UploadOutcome, cx: &App) -> Vec<Toast> {
    let mut toasts = Vec::new();
    let join = |names: &[String]| names.join(", ");
    let korean = Ds::get(cx).lang() == Lang::Ko;
    if !outcome.failed.is_empty() {
        let names = join(&outcome.failed);
        toasts.push(Toast::error(if korean {
            format!("{names} — 연결을 확인한 뒤 파일을 다시 선택해 주세요.")
        } else {
            format!("{names} — Check your connection, then select the file again.")
        }));
    }
    if !outcome.empty.is_empty() {
        let names = join(&outcome.empty);
        toasts.push(Toast::error(if korean {
            format!("{names} — 빈 파일입니다.")
        } else {
            format!("{names} — File is empty.")
        }));
    }
    if !outcome.oversized.is_empty() {
        let names = join(&outcome.oversized);
        let limit = format_size(ATTACHMENT_MAX_BYTES as i64);
        toasts.push(Toast::error(if korean {
            format!("{names} — 파일당 {limit} 이하로 줄이거나 다른 파일을 선택해 주세요.")
        } else {
            format!("{names} — Reduce each file to {limit} or less, or select another file.")
        }));
    }
    toasts
}

/// The refusal toast of `addFiles` (`notifyStatus(imageRefusalLabel(...), { duration: 2000 })`).
pub(crate) fn refusal_notice(label: impl Into<SharedString>) -> Toast {
    Toast::message(label).duration(Duration::from_secs(2))
}

/// `attachmentTile` and the tile's icon and blocked reason, for one attachment.
fn tile(
    attachment: &ComposerAttachment,
    extra: Option<&Extra>,
    blocked: Option<&SharedString>,
    cx: &App,
) -> AttachmentItem {
    let file = &attachment.file;
    let mut item = AttachmentItem::new(attachment.id.clone(), file.safe_name.clone())
        .meta(format_size(file.size_bytes))
        .extension(extension(&file.safe_name, cx));
    if let Some(preview) = extra.and_then(|e| e.preview.clone()) {
        item = item.thumbnail(preview, ThumbnailFit::Cover);
    }
    if extra.is_some_and(|e| e.project_document) {
        item = item.icon(Icon::BookOpenText);
    }
    if let Some(reason) = blocked {
        item = item.blocked(reason.clone());
    }
    item
}

/// `ComposerAttachments`: the elements chips, then the attachments as a row of tiles. `blocked`
/// maps an attachment id to the label of the image refusal that keeps it from being sent.
pub(crate) fn composer_attachments(
    attachments: &[ComposerAttachment],
    extras: &Attachments,
    blocked: &HashMap<String, SharedString>,
    elements: Option<AnyElement>,
    on_open: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    on_remove: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    cx: &App,
) -> Option<AnyElement> {
    let tiles = (!attachments.is_empty()).then(|| {
        let items = attachments
            .iter()
            .map(|attachment| {
                tile(
                    attachment,
                    extras.extras.get(&attachment.id),
                    blocked.get(&attachment.id),
                    cx,
                )
            })
            .collect();
        let lang = Ds::get(cx).lang();
        AttachmentList::new("composer-attachments", items)
            .variant(Variant::Tiles)
            .tile_layout(TileLayout::Row)
            .empty_label(tr(cx, "Attached files", "첨부 파일"))
            .on_open(on_open)
            .on_remove(on_remove)
            .remove_label(move |name| match lang {
                Lang::En => format!("Remove {name}"),
                Lang::Ko => format!("{name} 제거"),
            })
            .into_any_element()
    });
    if elements.is_none() && tiles.is_none() {
        return None;
    }
    Some(
        div()
            .flex()
            .flex_col()
            .children(elements)
            .children(tiles)
            .into_any_element(),
    )
}

/// The open handler's work: a picture opens in the image viewer among the draft's pictures; any
/// other file goes to `open_file` (the conversation's file viewer).
pub(crate) fn open_attachment(
    attachments: &[ComposerAttachment],
    id: &str,
    open_file: impl FnOnce(&MessageFileRef, &mut App),
    cx: &mut App,
) {
    let Some(attachment) = attachments.iter().find(|item| item.id == id) else {
        return;
    };
    if attachment.file.kind != MessageFileKind::Image {
        open_file(&attachment.file, cx);
        return;
    }
    let viewable: Vec<&ComposerAttachment> = attachments
        .iter()
        .filter(|item| item.file.kind == MessageFileKind::Image)
        .collect();
    let index = viewable
        .iter()
        .position(|item| item.id == attachment.id)
        .unwrap_or(0);
    let images = viewable
        .iter()
        .map(|item| ViewerImage {
            file_id: item.file.file_id.clone(),
            name: item.file.safe_name.clone(),
        })
        .collect();
    if cx.has_global::<ImageViewerHost>() {
        cx.update_global::<ImageViewerHost, _>(|host, _| host.open(images, index));
        cx.refresh_windows();
    }
}

/// A picked page element in the draft (`ElementDraft` item).
pub(crate) struct ElementDraftItem {
    pub(crate) id: SharedString,
    pub(crate) title: SharedString,
    pub(crate) site: SharedString,
    /// A library item shows as a plain chip.
    pub(crate) library: bool,
    /// The element's crop, or its image file, from the file's bytes.
    pub(crate) thumbnail: Option<ImageSource>,
    /// The image refusal label that keeps it from being sent.
    pub(crate) refusal: Option<SharedString>,
}

/// `ComposerElements`: the draft's picked elements as chips; `None` when there are none.
pub(crate) fn composer_elements(
    items: &[ElementDraftItem],
    on_remove: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    cx: &App,
) -> Option<AnyElement> {
    if items.is_empty() {
        return None;
    }
    let rows = items
        .iter()
        .map(|item| {
            let mut row =
                AttachmentItem::new(item.id.clone(), item.title.clone()).meta(item.site.clone());
            if !item.library && item.refusal.is_none() {
                row = row.element(item.site.clone());
            }
            if let Some(reason) = item.refusal.clone() {
                row = row.blocked(reason);
            }
            if let Some(src) = item.thumbnail.clone() {
                row = row.thumbnail(src, ThumbnailFit::Contain);
            }
            row
        })
        .collect();
    let delete = tr(cx, "Delete", "삭제");
    Some(
        AttachmentList::new("composer-elements", rows)
            .variant(Variant::Chips)
            .remove_label(move |_| delete.to_owned())
            .on_remove(on_remove)
            .into_any_element(),
    )
}
