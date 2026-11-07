//! `MessageMarkdown`, `MarkdownCodeBlock`, `MessageInlineImage`, `inlineImageFiles` on the DS
//! MarkdownContent. Replaces `markdown.rs` and `markdown_view.rs` (deleted at integration).
//!
//! `MessageMarkdown` is `MarkdownContent` with the code frame's copy action
//! (`MarkdownCodeBlock`) and the message-file image source (`MessageInlineImage`); the table,
//! link, syntax colours and streaming reveal are the DS block's.

use std::collections::{BTreeSet, HashMap};

use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::markdown::{Block, Inline, parse};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{
    AnyElement, App, ElementId, Image, ImageFormat, ImageSource, IntoElement as _, SharedString,
};

/// The path prefix of a message file (`MESSAGE_FILE_URL_PATTERN` in `messageFileUrls.ts`).
const MESSAGE_FILE_PREFIX: &str = "/message-files/file-";

/// Where one message file's picture stands.
enum Load {
    Pending,
    Ready(ImageSource),
    Failed,
}

/// The pictures of message files the transcript's Markdown shows, and the client that loads
/// them (`useMessageFileSource`). The shell sets the client when the connection changes.
#[derive(Default)]
pub(crate) struct MessageImages {
    client: Option<ShellClient>,
    files: HashMap<String, Load>,
}

impl gpui::Global for MessageImages {}

impl MessageImages {
    /// Replaces the client; pictures loaded through the old one are dropped.
    #[allow(dead_code, reason = "C3a skeleton: wired by the transcript writer")]
    pub(crate) fn set_client(cx: &mut App, client: Option<ShellClient>) {
        let images = cx.default_global::<Self>();
        images.client = client;
        images.files.clear();
    }
}

/// `MessageMarkdown`: a message's Markdown.
#[allow(dead_code, reason = "C3a skeleton: wired by the transcript writer")]
pub(crate) fn message_markdown(
    id: ElementId,
    text: SharedString,
    streaming: bool,
    cx: &mut App,
) -> AnyElement {
    let (copy, copied) = match Ds::get(cx).lang() {
        Lang::En => ("Copy code", "Copied"),
        Lang::Ko => ("코드 복사", "복사됨"),
    };
    let files = if text.contains(MESSAGE_FILE_PREFIX) {
        inline_image_files(&text)
    } else {
        BTreeSet::new()
    };
    let ready = ready_images(&files, cx);
    MarkdownContent::new(id, text)
        .streaming(streaming)
        .copy_code(copy, copied)
        .image_source(move |src| ready.get(src).cloned())
        .into_any_element()
}

/// `inlineImageFiles`: the message files the Markdown's images name, outside code and ordinary
/// links.
fn inline_image_files(text: &str) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    blocks_files(&parse(text), &mut files);
    files
}

fn blocks_files(blocks: &[Block], files: &mut BTreeSet<String>) {
    for block in blocks {
        match block {
            Block::Paragraph(nodes) | Block::Heading { content: nodes, .. } => {
                inlines_files(nodes, files);
            }
            Block::List { items, .. } => {
                for item in items {
                    blocks_files(&item.blocks, files);
                }
            }
            Block::Quote(inner) => blocks_files(inner, files),
            Block::Table(table) => {
                for cell in table.head.iter().chain(table.rows.iter().flatten()) {
                    inlines_files(cell, files);
                }
            }
            Block::Code { .. } | Block::Rule => {}
        }
    }
}

fn inlines_files(nodes: &[Inline], files: &mut BTreeSet<String>) {
    for node in nodes {
        match node {
            Inline::Image { src, .. } if is_message_file(src) => {
                files.insert(src.clone());
            }
            Inline::Link { children, .. } => inlines_files(children, files),
            _ => {}
        }
    }
}

/// `messageFilePath`: `/message-files/file-` and a 36-character id.
fn is_message_file(src: &str) -> bool {
    src.strip_prefix(MESSAGE_FILE_PREFIX)
        .is_some_and(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
}

/// The loaded pictures among `files`; starts the load of each one not yet asked for.
fn ready_images(files: &BTreeSet<String>, cx: &mut App) -> HashMap<String, ImageSource> {
    let mut ready = HashMap::new();
    let mut start = Vec::new();
    let images = cx.default_global::<MessageImages>();
    for file in files {
        match images.files.get(file) {
            Some(Load::Ready(source)) => {
                ready.insert(file.clone(), source.clone());
            }
            Some(Load::Pending | Load::Failed) => {}
            None => {
                if let Some(client) = images.client.clone() {
                    images.files.insert(file.clone(), Load::Pending);
                    start.push((file.clone(), client));
                }
            }
        }
    }
    for (file, client) in start {
        load(file, client, cx);
    }
    ready
}

/// Downloads a message file (`download_message_file`) and shows it once it is here.
fn load(file: String, client: ShellClient, cx: &mut App) {
    let (send, receive) = oneshot::channel();
    let id = file
        .strip_prefix("/message-files/")
        .unwrap_or_default()
        .to_owned();
    // The shell's connection runtime is the agent worker's; this download owns a small one.
    let spawned = std::thread::Builder::new()
        .name("message-image".into())
        .spawn(move || {
            let download = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .and_then(|runtime| runtime.block_on(client.download_message_file(&id)).ok());
            let _ = send.send(download.map(|download| (download.content_type, download.bytes)));
        });
    if spawned.is_err() {
        cx.default_global::<MessageImages>()
            .files
            .insert(file, Load::Failed);
        return;
    }
    cx.spawn(async move |cx| {
        let loaded = receive.await.ok().flatten();
        cx.update(|cx| {
            let state = loaded
                .and_then(|(content_type, bytes)| picture(content_type.as_deref(), bytes))
                .map_or(Load::Failed, Load::Ready);
            cx.default_global::<MessageImages>().files.insert(file, state);
        });
        cx.refresh();
    })
    .detach();
}

/// The picture a download carries, by its content type.
fn picture(content_type: Option<&str>, bytes: Vec<u8>) -> Option<ImageSource> {
    let mime = content_type?.split(';').next()?.trim();
    let format = ImageFormat::from_mime_type(mime)?;
    Some(ImageSource::Image(std::sync::Arc::new(Image::from_bytes(
        format, bytes,
    ))))
}
