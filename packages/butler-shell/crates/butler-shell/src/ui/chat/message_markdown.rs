//! `MessageMarkdown`, `MarkdownCodeBlock`, `MessageInlineImage`, `inlineImageFiles` on the DS
//! MarkdownContent.
//!
//! `MessageMarkdown` is `MarkdownContent` with the code frame's copy action
//! (`MarkdownCodeBlock`) and the message-file image source (`MessageInlineImage`); the table,
//! link, syntax colours and streaming reveal are the DS block's. The message-file walk of the
//! Markdown (`messageMedia`) lives here and the files rows share it.

use std::collections::{BTreeSet, HashMap};

use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::markdown::{Block, Inline, parse};
use gpui::{AnyElement, App, ElementId, ImageSource, IntoElement as _, SharedString};

use crate::ui::i18n::media::Media;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::source::wire::{MessageFileKind, MessageFileRef};

/// The path prefix of a message file (`MESSAGE_FILE_URL_PATTERN` in `messageFileUrls.ts`).
pub(in crate::ui::chat) const MESSAGE_FILE_DIR: &str = "/message-files/";

/// `MessageMarkdown`: a message's Markdown.
pub(crate) fn message_markdown(
    id: ElementId,
    text: SharedString,
    streaming: bool,
    cx: &mut App,
) -> AnyElement {
    message_markdown_in(id, text, streaming, &[], cx)
}

/// `MessageMarkdown` of a message with `attachments`: an image may also name one of them by
/// its file name.
pub(crate) fn message_markdown_in(
    id: ElementId,
    text: SharedString,
    streaming: bool,
    attachments: &[MessageFileRef],
    cx: &mut App,
) -> AnyElement {
    let copy = Media::get(cx);
    let ready = if text.contains("![") {
        ready_images(&text, attachments, cx)
    } else {
        HashMap::new()
    };
    MarkdownContent::new(id, text)
        .streaming(streaming)
        .copy_code(copy.copy_code, copy.copied)
        .image_source(move |src| ready.get(src).cloned())
        .into_any_element()
}

/// The loaded pictures of the message files the Markdown's images name, by the image's `src`;
/// starts the load of each one not yet asked for.
fn ready_images(
    text: &str,
    attachments: &[MessageFileRef],
    cx: &mut App,
) -> HashMap<String, ImageSource> {
    let mut ready = HashMap::new();
    for (src, _) in markdown_images(text) {
        let Some(id) = markdown_image_file(&src, attachments)
            .and_then(|url| file_id_of(&url).map(str::to_owned))
        else {
            continue;
        };
        if let Some(image) = picture(&PictureId::File(id), cx) {
            ready.insert(src, ImageSource::Image(image));
        }
    }
    ready
}

/// `messageFilePath`: `/message-files/file-` and a 36-character id.
pub(in crate::ui::chat) fn message_file_path(url: &str) -> Option<&str> {
    let id = url.strip_prefix("/message-files/file-")?;
    (id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')).then_some(url)
}

/// The id of a message file's path (what `download_message_file` takes).
pub(in crate::ui::chat) fn file_id_of(path: &str) -> Option<&str> {
    message_file_path(path)?.strip_prefix(MESSAGE_FILE_DIR)
}

fn normalized_file_name(value: &str) -> String {
    let without_query = value.split(['?', '#']).next().unwrap_or_default();
    let name = without_query.rsplit(['/', '\\']).next().unwrap_or_default();
    percent_encoding::percent_decode_str(name)
        .decode_utf8()
        .map_or_else(|_| name.to_lowercase(), |decoded| decoded.to_lowercase())
}

/// `markdownImageFile`: the url of the message file a Markdown image names: its
/// `/message-files/<id>` path, or the image attachment of that file name.
pub(in crate::ui::chat) fn markdown_image_file(
    source: &str,
    attachments: &[MessageFileRef],
) -> Option<String> {
    if let Some(path) = message_file_path(source) {
        return Some(path.to_owned());
    }
    let name = normalized_file_name(source);
    if name.is_empty() {
        return None;
    }
    attachments
        .iter()
        .find(|file| {
            file.kind == MessageFileKind::Image && normalized_file_name(&file.safe_name) == name
        })
        .map(|file| file.url.clone())
}

/// The images (`src`, alt) a message's Markdown shows, outside code.
pub(in crate::ui::chat) fn markdown_images(text: &str) -> Vec<(String, String)> {
    let mut images = Vec::new();
    blocks_images(&parse(text), &mut images);
    images
}

/// `inlineImageFiles`: the urls of the message files the text shows as images.
pub(in crate::ui::chat) fn inline_image_files(
    text: &str,
    attachments: &[MessageFileRef],
) -> BTreeSet<String> {
    markdown_images(text)
        .iter()
        .filter_map(|(src, _)| markdown_image_file(src, attachments))
        .collect()
}

fn blocks_images(blocks: &[Block], images: &mut Vec<(String, String)>) {
    for block in blocks {
        match block {
            Block::Paragraph(nodes) | Block::Heading { content: nodes, .. } => {
                inlines_images(nodes, images);
            }
            Block::List { items, .. } => {
                for item in items {
                    blocks_images(&item.blocks, images);
                }
            }
            Block::Quote(inner) => blocks_images(inner, images),
            Block::Table(table) => {
                for cell in table.head.iter().chain(table.rows.iter().flatten()) {
                    inlines_images(cell, images);
                }
            }
            Block::Code { .. } | Block::Rule => {}
        }
    }
}

fn inlines_images(nodes: &[Inline], images: &mut Vec<(String, String)>) {
    for node in nodes {
        match node {
            Inline::Image { src, alt } => images.push((src.clone(), alt.clone())),
            Inline::Link { children, .. } => inlines_images(children, images),
            _ => {}
        }
    }
}
