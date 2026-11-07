//! `media/ImageViewerHost` and its state: one DS ImageViewer at the frame level.
//!
//! `openImageViewer` / `closeImageViewer` are `open` / `close`; `ImageViewerHost` is `render`.
//! The pictures are message files, downloaded through the client the shell sets with
//! `ViewerPictures::set_client`.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::image_viewer::{ImageViewer, ViewerImage as DsImage, ViewerLabels};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{
    AnyElement, App, ClipboardItem, Image, ImageFormat, ImageSource, IntoElement as _,
    SharedString, Task, Window,
};

/// One image the viewer can show.
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Clone, Debug)]
pub(crate) struct ViewerImage {
    pub(crate) file_id: String,
    pub(crate) name: String,
}

/// The set the viewer pages through and the shown index (`useImageViewerState`).
type Shown = Option<(Vec<ViewerImage>, usize)>;

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
#[derive(Default)]
pub(crate) struct ImageViewerHost {
    open: Rc<RefCell<Shown>>,
}

impl gpui::Global for ImageViewerHost {}

/// Where one picture stands.
enum Load {
    Pending,
    Ready(Arc<Image>),
    Failed,
}

/// The viewer's pictures and the client that loads them.
#[derive(Default)]
pub(crate) struct ViewerPictures {
    client: Option<ShellClient>,
    files: HashMap<String, Load>,
}

impl gpui::Global for ViewerPictures {}

impl ViewerPictures {
    /// Replaces the client; pictures loaded through the old one are dropped.
    #[allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
    pub(crate) fn set_client(cx: &mut App, client: Option<ShellClient>) {
        let pictures = cx.default_global::<Self>();
        pictures.client = client;
        pictures.files.clear();
    }
}

#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
impl ImageViewerHost {
    pub(crate) fn open(&mut self, images: Vec<ViewerImage>, index: usize) {
        if index < images.len() {
            *self.open.borrow_mut() = Some((images, index));
        }
    }

    pub(crate) fn close(&mut self) {
        *self.open.borrow_mut() = None;
    }

    /// The viewer overlay while open.
    pub(crate) fn render(&self, _window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let (images, index) = self.open.borrow().clone()?;
        let pictures: Vec<Option<Arc<Image>>> = images
            .iter()
            .map(|image| picture(&image.file_id, cx))
            .collect();
        // The viewer shows once the picture it opens on is here.
        let current = pictures.get(index)?.clone();
        let current_loading = current.is_none() && is_pending(&images[index].file_id, cx);
        if current_loading {
            return None;
        }
        let shown = images
            .iter()
            .zip(&pictures)
            .map(|(image, picture)| DsImage {
                src: picture
                    .clone()
                    .map_or_else(|| ImageSource::from(String::new()), ImageSource::Image),
                alt: SharedString::from(image.name.clone()),
                caption: Some(SharedString::from(image.name.clone())),
                source: None,
            })
            .collect();
        let lang = Ds::get(cx).lang();
        let (open, close_open) = (self.open.clone(), self.open.clone());
        let mut viewer = ImageViewer::new("image-viewer", shown, Some(index), labels(lang))
            .on_index_change(move |next, window, _| {
                if let Some((_, index)) = open.borrow_mut().as_mut() {
                    *index = next;
                }
                window.refresh();
            })
            .on_close(move |window, _| {
                *close_open.borrow_mut() = None;
                window.refresh();
            });
        if let Some(image) = current {
            viewer = viewer.action(copy_action(image, index, lang, cx));
        }
        Some(viewer.into_any_element())
    }
}

fn labels(lang: Lang) -> ViewerLabels {
    let pick = |en: &'static str, ko: &'static str| match lang {
        Lang::En => SharedString::from(en),
        Lang::Ko => SharedString::from(ko),
    };
    ViewerLabels {
        close: pick("Close", "닫기"),
        previous: pick("Previous image", "이전 이미지"),
        next: pick("Next image", "다음 이미지"),
        failed: pick("Image unavailable", "이미지를 불러오지 못했어요"),
        zoom_in: Some(pick("Zoom in", "확대")),
        zoom_out: Some(pick("Zoom out", "축소")),
    }
}

/// The copy-image action (`copyViewerImage`), keyed by the shown index so each picture starts
/// without the done check.
fn copy_action(image: Arc<Image>, index: usize, lang: Lang, cx: &App) -> DoneIconButton {
    let (label, done) = match lang {
        Lang::En => ("Copy image", "Image copied"),
        Lang::Ko => ("이미지 복사", "이미지를 복사했어요"),
    };
    DoneIconButton::new(("viewer-copy", index), label, done)
        .icon(icon(Icon::Copy, IconSize::Sm, Ds::get(cx)))
        .on_action(move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            Task::ready(Ok(()))
        })
}

fn is_pending(file: &str, cx: &mut App) -> bool {
    matches!(
        cx.default_global::<ViewerPictures>().files.get(file),
        Some(Load::Pending)
    )
}

/// The loaded picture of `file`; starts its download when it was not asked for yet.
fn picture(file: &str, cx: &mut App) -> Option<Arc<Image>> {
    let pictures = cx.default_global::<ViewerPictures>();
    match pictures.files.get(file) {
        Some(Load::Ready(image)) => return Some(image.clone()),
        Some(Load::Pending | Load::Failed) => return None,
        None => {}
    }
    let client = pictures.client.clone()?;
    pictures.files.insert(file.to_owned(), Load::Pending);
    load(file.to_owned(), client, cx);
    None
}

/// Downloads a message file (`download_message_file`) and shows it once it is here.
fn load(file: String, client: ShellClient, cx: &mut App) {
    let (send, receive) = oneshot::channel();
    let id = file.clone();
    // The shell's connection runtime is the agent worker's; this download owns a small one.
    let spawned = std::thread::Builder::new()
        .name("viewer-image".into())
        .spawn(move || {
            let download = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .and_then(|runtime| runtime.block_on(client.download_message_file(&id)).ok());
            let _ = send.send(download.map(|download| (download.content_type, download.bytes)));
        });
    if spawned.is_err() {
        cx.default_global::<ViewerPictures>()
            .files
            .insert(file, Load::Failed);
        return;
    }
    cx.spawn(async move |cx| {
        let loaded = receive.await.ok().flatten();
        cx.update(|cx| {
            let state = loaded
                .and_then(|(content_type, bytes)| decode(content_type.as_deref(), bytes))
                .map_or(Load::Failed, Load::Ready);
            cx.default_global::<ViewerPictures>()
                .files
                .insert(file, state);
        });
        cx.refresh();
    })
    .detach();
}

/// The picture a download carries, by its content type.
fn decode(content_type: Option<&str>, bytes: Vec<u8>) -> Option<Arc<Image>> {
    let mime = content_type?.split(';').next()?.trim();
    let format = ImageFormat::from_mime_type(mime)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}
