//! An epic's attachments: the references a description makes (`epicAttachmentReferences.ts`),
//! its Markdown (`EpicMarkdown.tsx`) and the file upload both epic forms share
//! (`useEpicAttachments.tsx`, `uploadCanonFile`).
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use butler_ds::ui::blocks::markdown_content::{Density, MarkdownContent};
use butler_ds::ui::markdown::{Block, Inline, parse};
use butler_shell_client::{Error, Upload};
use gpui::{
    AnyElement, App, Context, ElementId, ImageSource, IntoElement as _, PathPromptOptions,
    SharedString,
};
use regex::{Captures, Regex};
use serde::Deserialize;

use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::CanonAttachment;

/// `file.size > 10 * 1024 * 1024`
const MAX_BYTES: u64 = 10 * 1024 * 1024;
const SCHEME: &str = "attachment:";

/// The part of a stored file a description names (React's `MessageFileRef`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct AttachedFile {
    pub(crate) file_id: String,
    /// "image" | "text" | "generic"
    pub(crate) kind: String,
    pub(crate) safe_name: String,
    /// `/message-files/<id>`
    pub(crate) url: String,
}

impl From<&CanonAttachment> for AttachedFile {
    fn from(file: &CanonAttachment) -> Self {
        Self {
            file_id: file.file_id.clone(),
            kind: file.kind.clone(),
            safe_name: file.safe_name.clone(),
            url: file.url.clone(),
        }
    }
}

impl AttachedFile {
    pub(crate) fn is_image(&self) -> bool {
        self.kind == "image"
    }

    /// The id the message-file routes take.
    pub(crate) fn path_id(&self) -> &str {
        self.url
            .strip_prefix("/message-files/")
            .unwrap_or(&self.file_id)
    }

    /// `![name](attachment:id)` for a picture, `[name](attachment:id)` otherwise.
    pub(crate) fn reference(&self) -> String {
        let name: String = self
            .safe_name
            .chars()
            .flat_map(|c| match c {
                '\\' | '[' | ']' => vec!['\\', c],
                '\r' | '\n' => vec![' '],
                _ => vec![c],
            })
            .collect();
        let bang = if self.is_image() { "!" } else { "" };
        format!("{bang}[{name}]({SCHEME}{})", self.file_id)
    }
}

fn scheme_rest(url: &str) -> Option<&str> {
    url.get(..SCHEME.len())
        .filter(|head| head.eq_ignore_ascii_case(SCHEME))
        .and_then(|_| url.get(SCHEME.len()..))
}

/// `epicAttachmentReferences`: the file ids Markdown links or images name, never code or plain
/// text.
pub(crate) fn references(description: &str) -> HashSet<String> {
    let mut files = HashSet::new();
    blocks(&parse(description), &mut files);
    files
}

fn blocks(list: &[Block], files: &mut HashSet<String>) {
    for block in list {
        match block {
            Block::Paragraph(nodes) | Block::Heading { content: nodes, .. } => {
                inlines(nodes, files);
            }
            Block::List { items, .. } => items.iter().for_each(|item| blocks(&item.blocks, files)),
            Block::Quote(inner) => blocks(inner, files),
            Block::Table(table) => {
                for cell in table.head.iter().chain(table.rows.iter().flatten()) {
                    inlines(cell, files);
                }
            }
            Block::Code { .. } | Block::Rule => {}
        }
    }
}

fn inlines(nodes: &[Inline], files: &mut HashSet<String>) {
    for node in nodes {
        match node {
            Inline::Link { href, children } => {
                files.extend(scheme_rest(href).map(str::to_owned));
                inlines(children, files);
            }
            Inline::Image { src, .. } => files.extend(scheme_rest(src).map(str::to_owned)),
            _ => {}
        }
    }
}

/// An inline link or image to an attachment.
static INLINE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)(!?)(\[(?:\\.|[^\]\\])*\]\()attachment:[^\s)]*").ok());

/// A link to an attachment goes nowhere in a native view (`urlTransform` drops what it cannot
/// load): it becomes a fragment, which the DS link ignores. Pictures stay for the image source.
fn without_attachment_links(text: &str) -> String {
    let Some(inline) = INLINE.as_ref() else {
        return text.to_owned();
    };
    inline
        .replace_all(text, |caps: &Captures| {
            let part = |index| caps.get(index).map_or("", |m| m.as_str());
            if part(1) == "!" {
                part(0).to_owned()
            } else {
                format!("{}#", part(2))
            }
        })
        .into_owned()
}

/// `EpicMarkdown`: only explicit attachment references load pictures from this epic's files.
pub(crate) fn markdown(
    id: impl Into<ElementId>,
    description: &str,
    files: &[AttachedFile],
    compact: bool,
    cx: &mut App,
) -> AnyElement {
    let mut ready: HashMap<String, ImageSource> = HashMap::new();
    if description.contains("![") {
        let named = references(description);
        for file in files
            .iter()
            .filter(|f| f.is_image() && named.contains(&f.file_id))
        {
            if let Some(image) = picture(&PictureId::File(file.path_id().to_owned()), cx) {
                ready.insert(file.file_id.clone(), ImageSource::Image(image));
            }
        }
    }
    MarkdownContent::new(id, without_attachment_links(description))
        .density(if compact {
            Density::Compact
        } else {
            Density::Document
        })
        .image_source(move |src| scheme_rest(src).and_then(|file| ready.get(file).cloned()))
        .into_any_element()
}

/// Why an upload did not attach.
pub(crate) enum UploadError {
    TooLarge,
    Failed,
}

struct Picked {
    name: String,
    mime: &'static str,
    bytes: Vec<u8>,
}

/// The media type a browser's `File.type` reports for a name.
fn mime_of(name: &str) -> &'static str {
    match name
        .rsplit_once('.')
        .map_or("", |(_, e)| e)
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

fn read_picked(path: &Path) -> Result<Picked, UploadError> {
    let size = std::fs::metadata(path)
        .map_err(|_| UploadError::Failed)?
        .len();
    if size > MAX_BYTES {
        return Err(UploadError::TooLarge);
    }
    let bytes = std::fs::read(path).map_err(|_| UploadError::Failed)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or(UploadError::Failed)?;
    Ok(Picked {
        mime: mime_of(&name),
        name,
        bytes,
    })
}

#[derive(Deserialize)]
struct Uploaded {
    file: AttachedFile,
}

/// The attach button: the file dialog, then `POST /projects/{id}/canon/files`. `started` runs once
/// a file is read (its name), `done` with the stored file or why not; neither runs when the dialog
/// is dismissed.
pub(crate) fn pick_and_upload<P: 'static>(
    project: SharedString,
    cx: &mut Context<P>,
    started: impl FnOnce(&mut P, SharedString, &mut Context<P>) + 'static,
    done: impl FnOnce(&mut P, Result<AttachedFile, UploadError>, &mut Context<P>) + 'static,
) {
    let chosen = cx.prompt_for_paths(PathPromptOptions {
        files: true,
        directories: false,
        multiple: false,
        prompt: None,
    });
    cx.spawn(async move |this, cx| {
        let path = chosen
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .and_then(|paths| paths.into_iter().next());
        let Some(path) = path else {
            return;
        };
        let read = cx
            .background_executor()
            .spawn(async move { read_picked(&path) })
            .await;
        let _ = this.update(cx, move |this, cx| match read {
            Ok(file) => {
                started(this, file.name.clone().into(), cx);
                upload(project, file, cx, done);
            }
            Err(error) => done(this, Err(error), cx),
        });
    })
    .detach();
}

fn upload<P: 'static>(
    project: SharedString,
    file: Picked,
    cx: &mut Context<P>,
    done: impl FnOnce(&mut P, Result<AttachedFile, UploadError>, &mut Context<P>) + 'static,
) {
    fetch(
        cx,
        move |client| async move {
            let upload = Upload {
                file_name: file.name,
                content_type: file.mime.to_owned(),
                bytes: file.bytes,
            };
            client.upload_canon_file(&project, &upload).await
        },
        move |this: &mut P, result: Result<Uploaded, Error>, cx| {
            let stored = result.map(|u| u.file).map_err(|error| match error {
                // CARVE-OUT(G-codes): `file_too_large` is told from other refusals by status.
                Error::Http(413) => UploadError::TooLarge,
                _ => UploadError::Failed,
            });
            done(this, stored, cx);
        },
    );
}
