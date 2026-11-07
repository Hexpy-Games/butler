//! `media/ImageViewerHost` and its state: one DS ImageViewer at the frame level.
//!
//! `openImageViewer` / `closeImageViewer` are `open` / `close`; `ImageViewerHost` is `render`,
//! and `overlay` is the frame's call. The pictures come from the shared loader.
pub(crate) mod loader;
pub(crate) mod source;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::image_viewer::{
    ImageViewer, ViewerImage as DsImage, ViewerLabels, ViewerSource,
};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use gpui::{
    AnyElement, App, BorrowAppContext as _, ClipboardItem, Image, ImageSource, IntoElement as _,
    SharedString, Task, Window,
};

use self::loader::PictureId;
use crate::ui::i18n::media::Media;

/// One message file the viewer can show.
#[derive(Clone, Debug)]
pub(crate) struct ViewerImage {
    pub(crate) file_id: String,
    pub(crate) name: String,
}

/// One picture of a set: where it loads from, its name, and the page it came from.
#[derive(Clone, Debug)]
pub(crate) struct ViewerEntry {
    pub(crate) id: PictureId,
    pub(crate) name: String,
    pub(crate) caption: Option<String>,
    /// The page the picture shows or came from (`ViewerImage.source`).
    pub(crate) source: Option<String>,
    /// When the source was read (ISO time).
    pub(crate) checked: Option<String>,
}

impl ViewerEntry {
    /// A picture with a name only.
    pub(crate) fn new(id: PictureId, name: String) -> Self {
        Self {
            id,
            name,
            caption: None,
            source: None,
            checked: None,
        }
    }
}

impl From<ViewerImage> for ViewerEntry {
    fn from(image: ViewerImage) -> Self {
        Self::new(PictureId::File(image.file_id), image.name)
    }
}

/// The set the viewer pages through and the shown index (`useImageViewerState`).
type Shown = Option<(Vec<ViewerEntry>, usize)>;

#[derive(Clone, Default)]
pub(crate) struct ImageViewerHost {
    open: Rc<RefCell<Shown>>,
}

impl gpui::Global for ImageViewerHost {}

/// Registers the window's one viewer; the shell calls it once at init.
pub(crate) fn install(cx: &mut App) {
    cx.set_global(ImageViewerHost::default());
}

/// `openImageViewer`: opens the viewer on `images` at `index`.
pub(crate) fn open(images: Vec<ViewerEntry>, index: usize, cx: &mut App) {
    if cx.has_global::<ImageViewerHost>() {
        cx.update_global::<ImageViewerHost, _>(|host, _| host.open_entries(images, index));
        cx.refresh_windows();
    }
}

/// The viewer overlay the frame draws on top while a picture is open.
pub(crate) fn overlay(window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let host = cx.try_global::<ImageViewerHost>()?.clone();
    host.render(window, cx)
}

impl ImageViewerHost {
    /// Opens on message files.
    pub(crate) fn open(&mut self, images: Vec<ViewerImage>, index: usize) {
        self.open_entries(images.into_iter().map(ViewerEntry::from).collect(), index);
    }

    fn open_entries(&mut self, images: Vec<ViewerEntry>, index: usize) {
        if index < images.len() {
            *self.open.borrow_mut() = Some((images, index));
        }
    }

    /// The viewer overlay while open.
    pub(crate) fn render(&self, _window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let (images, index) = self.open.borrow().clone()?;
        let pictures: Vec<Option<Arc<Image>>> = images
            .iter()
            .map(|image| loader::picture(&image.id, cx))
            .collect();
        // The viewer shows once the picture it opens on is here.
        let current = pictures.get(index)?.clone();
        if current.is_none() && loader::is_pending(&images[index].id, cx) {
            return None;
        }
        let lang = Ds::get(cx).lang();
        let shown = images
            .iter()
            .zip(&pictures)
            .map(|(image, picture)| shown_image(image, picture.clone(), lang))
            .collect();
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
        if let Some(url) = images[index].source.clone() {
            viewer = viewer.action(source_action(url, index, self.open.clone(), lang));
        }
        if let Some(image) = current {
            viewer = viewer.action(copy_action(image, index, lang, cx));
        }
        Some(viewer.into_any_element())
    }
}

/// `viewerImage`: one entry as the DS viewer shows it.
fn shown_image(entry: &ViewerEntry, picture: Option<Arc<Image>>, lang: Lang) -> DsImage {
    let src = picture.map_or_else(|| ImageSource::from(String::new()), ImageSource::Image);
    let caption = entry
        .caption
        .clone()
        .or_else(|| Some(entry.name.clone()).filter(|name| !name.is_empty()));
    let source = entry
        .source
        .as_deref()
        .and_then(source::site_of)
        .map(|site| ViewerSource {
            site: site.into(),
            checked: entry
                .checked
                .as_deref()
                .and_then(source::checked_label)
                .map(|time| SharedString::from(Media::checked(lang, &time))),
            icon: None,
        });
    DsImage {
        src,
        alt: SharedString::from(entry.name.clone()),
        caption: caption.map(SharedString::from),
        source,
    }
}

fn labels(lang: Lang) -> ViewerLabels {
    let copy = Media::of(lang);
    ViewerLabels {
        close: copy.close.into(),
        previous: copy.previous_image.into(),
        next: copy.next_image.into(),
        failed: copy.image_unavailable.into(),
        zoom_in: Some(copy.zoom_in.into()),
        zoom_out: Some(copy.zoom_out.into()),
    }
}

/// The open-source action: closes the viewer and opens the page.
fn source_action(url: String, index: usize, open: Rc<RefCell<Shown>>, lang: Lang) -> IconButton {
    IconButton::new(("viewer-source", index), Media::of(lang).open_source)
        .glyph(Icon::Popup)
        .on_click(move |_, window, cx| {
            *open.borrow_mut() = None;
            window.refresh();
            crate::ui::chat::open_link(&url, cx);
        })
}

/// The copy-image action (`copyViewerImage`), keyed by the shown index so each picture starts
/// without the done check.
fn copy_action(image: Arc<Image>, index: usize, lang: Lang, cx: &App) -> DoneIconButton {
    let copy = Media::of(lang);
    DoneIconButton::new(("viewer-copy", index), copy.copy_image, copy.image_copied)
        .icon(icon(Icon::Copy, IconSize::Sm, Ds::get(cx)))
        .on_action(move |_, cx| {
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            Task::ready(Ok(()))
        })
}
