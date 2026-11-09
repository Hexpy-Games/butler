//! DS PageContainer (PageContainer.tsx / PageContainer.module.css): the page frame, centred and
//! capped by the page width tokens, with the adaptive inline gutter. Grid's responsive columns
//! query its width (`container: page`); in gpui that is `Grid::page_container`.
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::layout::Space;
use crate::ui::strut;

/// The viewport width at or under which the unset gutter becomes the adaptive page gutter.
const ADAPTIVE_GUTTER_AT: f32 = 700.; // DS: PageContainer.module.css:57

/// The inline padding (`none` .. `2xl`); unset, the adaptive page gutter.
pub type Gutter = Space;

/// `narrow`: reading width (760px). `default`: wide page (72rem). `wide`: a document filling its
/// pane (React `document`, 1400px). `full`: no cap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PageWidth {
    Narrow,
    #[default]
    Default,
    Wide,
    Full,
}

#[derive(IntoElement)]
pub struct PageContainer {
    width: PageWidth,
    gutter: Option<Gutter>,
    start: bool,
    children: Vec<AnyElement>,
}

impl PageContainer {
    pub fn new() -> Self {
        Self {
            width: PageWidth::Default,
            gutter: None,
            start: false,
            children: Vec::new(),
        }
    }

    pub fn width(mut self, width: PageWidth) -> Self {
        self.width = width;
        self
    }

    /// Inline padding; omit for the adaptive page gutter.
    pub fn gutter(mut self, gutter: Gutter) -> Self {
        self.gutter = Some(gutter);
        self
    }

    /// `align="start"`: the capped page stays at the inline start (settings detail).
    pub fn align_start(mut self) -> Self {
        self.start = true;
        self
    }
}

impl Default for PageContainer {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for PageContainer {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for PageContainer {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let side = match self.gutter {
            Some(gutter) => gutter.px(ds),
            None if f32::from(window.viewport_size().width) <= ADAPTIVE_GUTTER_AT => {
                ds.len(Length::AdaptivePageGutter)
            }
            None => ds.len(Length::PageContainerGutter),
        };
        let mut el = div().w_full().min_w_0().px(side);
        el = match self.width {
            PageWidth::Narrow => el.max_w(ds.len(Length::PageContainerNarrow)),
            PageWidth::Default => el.max_w(ds.len(Length::PageContainerDefault)),
            PageWidth::Wide => el.max_w(ds.len(Length::PageContainerDocument)),
            PageWidth::Full => el,
        };
        if !self.start {
            el = el.mx_auto();
        }
        strut::scope(true, el.children(self.children))
    }
}
