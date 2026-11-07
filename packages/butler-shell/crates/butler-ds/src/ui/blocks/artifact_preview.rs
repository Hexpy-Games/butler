//! DS ArtifactPreview (ArtifactPreview.tsx / ArtifactPreview.module.css): the box an artifact's
//! content shows in: a bordered, scrolling card (at least 280px tall, at most the window less
//! the title bar and 210px), or with `page` no box at all, the content flowing in the host's
//! scroll. Its parts: a code-font pre, a picture at its own size up to the box's width, and a
//! frame. A web frame (PDF, HTML) is the P5 browser's: here it is the empty frame box at its
//! size, with no page in it.
use gpui::{
    AnyElement, App, ElementId, ImageSource, InteractiveElement as _, IntoElement, ObjectFit,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Window, div, img, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::typo::{Role, Typo, Wrap};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Surface {
    /// A bordered box with its own scroll.
    #[default]
    Card,
    /// No box and no inner scroll (a docked file viewer).
    Page,
}

#[derive(IntoElement)]
pub struct ArtifactPreview {
    id: ElementId,
    surface: Surface,
    children: Vec<AnyElement>,
}

impl ArtifactPreview {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            surface: Surface::Card,
            children: Vec::new(),
        }
    }

    pub fn surface(mut self, surface: Surface) -> Self {
        self.surface = surface;
        self
    }
}

impl ParentElement for ArtifactPreview {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ArtifactPreview {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        if self.surface == Surface::Page {
            return div().min_w_0().children(self.children).into_any_element();
        }
        let max = ds.len(Length::AdaptiveViewportBlockSize)
            - ds.len(Length::TitlebarSafeAreaTop)
            - px(210.);
        div()
            .id(self.id)
            .min_h(px(280.))
            .max_h(max)
            .min_w_0()
            .overflow_y_scroll()
            .p(ds.len(Length::SpaceMd))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusControl))
            .bg(ds.color(Color::SurfaceRaised))
            .children(self.children)
            .into_any_element()
    }
}

/// `ArtifactPreviewPre`: the text in the code font, wrapping anywhere, keeping its breaks.
#[derive(IntoElement)]
pub struct ArtifactPreviewPre {
    text: SharedString,
}

impl ArtifactPreviewPre {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into() }
    }
}

impl RenderOnce for ArtifactPreviewPre {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().child(
            Typo::new(Role::Code, self.text)
                .wrap(Wrap::Pre)
                .tone(crate::ui::typo::Tone::Primary),
        )
    }
}

/// `ArtifactPreviewImage`: the picture at its own display size, never wider than the box.
type OpenHandler = std::rc::Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ArtifactPreviewImage {
    src: ImageSource,
    natural: (f32, f32),
    on_open: Option<OpenHandler>,
}

impl ArtifactPreviewImage {
    /// `natural` is the picture's display size in logical px.
    pub fn new(src: impl Into<ImageSource>, natural: (f32, f32)) -> Self {
        Self {
            src: src.into(),
            natural,
            on_open: None,
        }
    }

    /// Opens the picture in a viewer.
    pub fn on_open(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_open = Some(std::rc::Rc::new(handler));
        self
    }
}

impl RenderOnce for ArtifactPreviewImage {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (width, height) = self.natural;
        let picture = div()
            .id("artifact-preview-image")
            .w(px(width))
            .max_w_full()
            .aspect_ratio(width / height)
            .child(
                img(self.src)
                    .size_full()
                    .rounded(ds.len(Length::RadiusControl))
                    .object_fit(ObjectFit::Contain),
            );
        match self.on_open {
            Some(open) => picture
                .cursor_pointer()
                .on_click(move |_, window, cx| open(window, cx))
                .into_any_element(),
            None => picture.into_any_element(),
        }
    }
}

/// `ArtifactPreviewFrame`: the frame box, 520px tall at least and the box's width, or exactly
/// `intrinsic` size. No page loads in it.
#[derive(IntoElement)]
pub struct ArtifactPreviewFrame {
    intrinsic: Option<(f32, f32)>,
}

impl ArtifactPreviewFrame {
    pub fn new() -> Self {
        Self { intrinsic: None }
    }

    /// Content that must show at its own size (a scrap's clipped part).
    pub fn intrinsic_size(mut self, width: f32, height: f32) -> Self {
        self.intrinsic = Some((width, height));
        self
    }
}

impl Default for ArtifactPreviewFrame {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for ArtifactPreviewFrame {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let frame = div().bg(ds.color(Color::Surface));
        match self.intrinsic {
            Some((width, height)) => frame.flex_none().w(px(width)).h(px(height)),
            None => frame
                .w_full()
                .min_h(px(520.))
                .rounded(ds.len(Length::RadiusControl)),
        }
    }
}
