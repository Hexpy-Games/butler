//! DS ImageViewer (ImageViewer.tsx / ImageViewerSurface.tsx / ImageViewerPicture.tsx /
//! ImageViewer.module.css): a modal lightbox. The picture is fitted to the window on a blurred
//! surface-tone scrim, previous and next step through its set (buttons and the arrow keys), the
//! caption and source line sit under it, and the container's actions and Close in the bar (Esc
//! and a click on the scrim close too). Pictures open fitted and zoom up to 4x (double click, the
//! wheel with Cmd or Ctrl, pinch, the +, - and 0 keys and the zoom buttons); a drag pans while
//! zoomed. Video items and focus restoration to the opener are not reproduced.
mod chrome;
mod surface;
mod zoom;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, ImageSource, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div, point,
};

pub use self::surface::ImageViewerSurface;
use crate::ui::context::Ds;
use crate::ui::layer::{Layer, Z};

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;
type IndexHandler = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// Where a picture was read: the provenance line under the caption.
#[derive(Clone)]
pub struct ViewerSource {
    pub site: SharedString,
    pub checked: Option<SharedString>,
    pub icon: Option<ImageSource>,
}

/// One picture of the set; `alt` names it, `caption` is the visible line.
#[derive(Clone)]
pub struct ViewerImage {
    pub src: ImageSource,
    pub alt: SharedString,
    pub caption: Option<SharedString>,
    pub source: Option<ViewerSource>,
}

/// The chrome's copy; the container passes app copy.
#[derive(Clone)]
pub struct ViewerLabels {
    pub close: SharedString,
    pub previous: SharedString,
    pub next: SharedString,
    pub failed: SharedString,
    pub zoom_in: Option<SharedString>,
    pub zoom_out: Option<SharedString>,
}

#[derive(IntoElement)]
pub struct ImageViewer {
    id: ElementId,
    images: Rc<Vec<ViewerImage>>,
    index: Option<usize>,
    labels: ViewerLabels,
    actions: Vec<AnyElement>,
    on_index_change: Option<IndexHandler>,
    on_close: Option<Handler>,
}

impl ImageViewer {
    /// `index` is the shown picture; `None` closes the viewer.
    pub fn new(
        id: impl Into<ElementId>,
        images: Vec<ViewerImage>,
        index: Option<usize>,
        labels: ViewerLabels,
    ) -> Self {
        Self {
            id: id.into(),
            images: Rc::new(images),
            index,
            labels,
            actions: Vec::new(),
            on_index_change: None,
            on_close: None,
        }
    }

    /// An IconButton for the shown picture, set beside Close.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    pub fn on_index_change(
        mut self,
        handler: impl Fn(usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_index_change = Some(Rc::new(handler));
        self
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ImageViewer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Some(index) = self.index.filter(|index| *index < self.images.len()) else {
            return div().into_any_element();
        };
        let (width, height) = Ds::get(cx).tokens().viewport;
        let total = self.images.len();
        let step = |to: Option<usize>| {
            to.zip(self.on_index_change.clone()).map(|(to, handler)| {
                Rc::new(move |window: &mut Window, cx: &mut App| handler(to, window, cx)) as Handler
            })
        };
        let previous = step(index.checked_sub(1));
        let next = step((index + 1 < total).then_some(index + 1));
        let surface = ImageViewerSurface::new(
            (self.id.clone(), "surface"),
            self.images[index].clone(),
            (index, total),
            self.labels,
        )
        .actions(self.actions)
        .on_previous(previous)
        .on_next(next)
        .on_close(self.on_close)
        .take_focus(window, cx);
        Layer::new(
            Z::Dialog,
            point(gpui::px(0.), gpui::px(0.)),
            div().w(gpui::px(width)).h(gpui::px(height)).child(surface),
        )
        .into_any_element()
    }
}
