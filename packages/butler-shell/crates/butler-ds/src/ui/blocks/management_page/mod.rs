//! DS ManagementPage (ManagementPage.tsx / ManagementPage.module.css): the frame of a management
//! view: a scrolling page in a PageContainer with an optional footer (in flow, or an overlay
//! composer that keeps clear of the aside), an optional background layer, and an aside that docks
//! flat in the right margin from 1000px or floats on TintedGlass below it.
mod aside;
mod panel;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    ScrollHandle, SharedString, Styled as _, Window, div, px,
};

use super::conversation_shell::shown;
use super::measure;
use super::scope::{self, ConversationVars, Spec};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::layout::Stack;
use crate::ui::page_container::{PageContainer, PageWidth};
use crate::ui::scroll::ScrollArea;
use crate::ui::scroll::engine::{self, Axis, Config};

pub use super::conversation_shell::{AsideContent, AsideLayout};
pub use aside::DOCK_MIN as ASIDE_DOCK_MIN;
pub use panel::ManagementPagePanel;

/// The overlay footer's own room above the page's bottom edge.
const FOOTER_ROOM: f32 = 22.; // DS: ManagementPage.module.css:61
/// A page's bottom padding (`.content`), and its compact minimum.
const BOTTOM: f32 = 56.; // DS: ManagementPage.module.css:70
const COMPACT_BOTTOM: f32 = 48.; // DS: ManagementPage.module.css:76

/// Where the footer sits: below the scroll area, or over the page (a composer).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FooterPlacement {
    #[default]
    Flow,
    Overlay,
}

/// How the background sits behind the content. `Calm`: a veil (`--management-page-veil`) lowers
/// its contrast. `None`: shown as is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BackgroundTreatment {
    #[default]
    Calm,
    None,
}

/// The page's scroller handle, to restore or read its scroll position. The scroller is the DS
/// ScrollArea's, which owns its handle, so this reads it instead of taking one.
pub fn scroll_handle(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> ScrollHandle {
    let id: ElementId = id.into();
    let ds = Ds::get(cx);
    let config = Config {
        id: (id, "scroll").into(),
        axis: Axis::Y,
        size: ds.len(Length::ScrollFadeSize),
        guard: ds.len(Length::SpaceXs),
    };
    engine::fade(&config, None, false, window, cx).handle
}

#[derive(IntoElement)]
pub struct ManagementPage {
    id: ElementId,
    width: PageWidth,
    footer: Option<AnyElement>,
    placement: FooterPlacement,
    reserve: f32,
    background: Option<AnyElement>,
    treatment: BackgroundTreatment,
    aside: Option<AsideContent>,
    aside_float_open: bool,
    aside_label: Option<SharedString>,
    children: Vec<AnyElement>,
}

impl ManagementPage {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            width: PageWidth::Default,
            footer: None,
            placement: FooterPlacement::Flow,
            reserve: 0.,
            background: None,
            treatment: BackgroundTreatment::Calm,
            aside: None,
            aside_float_open: false,
            aside_label: None,
            children: Vec::new(),
        }
    }

    /// The page width of the content (PageContainer); the default caps at 72rem.
    pub fn width(mut self, width: PageWidth) -> Self {
        self.width = width;
        self
    }

    pub fn footer(mut self, footer: impl IntoElement) -> Self {
        self.footer = Some(footer.into_any_element());
        self
    }

    pub fn footer_placement(mut self, placement: FooterPlacement) -> Self {
        self.placement = placement;
        self
    }

    /// The room an overlay footer takes above the page's bottom edge (`--footer-reserve`).
    pub fn footer_reserve(mut self, reserve: f32) -> Self {
        self.reserve = reserve;
        self
    }

    /// A decorative layer behind the scrolling content, confined to the page. With one,
    /// `ManagementPagePanel`s become TintedGlass surfaces.
    // CARVE-OUT(G-wall): nothing fills it yet; the slot renders whatever it is given.
    pub fn background(mut self, background: impl IntoElement) -> Self {
        self.background = Some(background.into_any_element());
        self
    }

    pub fn background_treatment(mut self, treatment: BackgroundTreatment) -> Self {
        self.treatment = treatment;
        self
    }

    /// A detail beside the content (a selected item). From a 1000px page it docks flat in the
    /// right margin and the content and an overlay footer narrow to its left; narrower, it floats
    /// on TintedGlass over the page while `aside_float_open`. It gets the layout.
    pub fn aside(mut self, content: impl Fn(AsideLayout) -> AnyElement + 'static) -> Self {
        self.aside = Some(std::rc::Rc::new(content));
        self
    }

    /// Floating only: whether the aside shows. Docked, it shows whenever `aside` is set.
    pub fn aside_float_open(mut self, open: bool) -> Self {
        self.aside_float_open = open;
        self
    }

    /// The aside's name (it ids the element; gpui has no landmark).
    pub fn aside_label(mut self, label: impl Into<SharedString>) -> Self {
        self.aside_label = Some(label.into());
        self
    }
}

impl ParentElement for ManagementPage {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The lengths of one page, from tokens.
struct Metrics {
    compact: bool,
    keep_out: f32,
    overlay_bottom: f32,
    inset: f32,
    reading: f32,
}

impl Metrics {
    fn of(page: &ManagementPage, docked: bool, window: &Window, ds: &Ds) -> Self {
        let len = |token| f32::from(ds.len(token));
        Self {
            compact: f32::from(window.viewport_size().width) <= panel::COMPACT_AT,
            keep_out: if docked { aside::keep_out(ds) } else { 0. },
            overlay_bottom: page.reserve
                + FOOTER_ROOM
                + len(Length::SafeAreaBottom)
                + len(Length::KeyboardInsetBottom),
            inset: len(Length::AdaptiveComposerInset),
            reading: len(Length::PageMaxWidthReading),
        }
    }

    /// What an overlay footer reads, as the conversation's composer does: the column's width and
    /// place, narrower beside a docked aside.
    fn column(&self, width: f32, reserve: f32) -> ConversationVars {
        let column = self
            .reading
            .min(width - self.keep_out - 2. * self.inset)
            .max(0.);
        let shift = self.keep_out / 2.;
        ConversationVars {
            composer_reserve: reserve,
            width,
            column_width: if width > 0. { column } else { 0. },
            column_left: ((width - column) / 2. - shift).max(0.),
            column_shift: shift,
            top_reserve: 0.,
        }
    }
}

impl ManagementPage {
    /// The scrolling content: padding, the page container and the children at the page gap.
    fn content(&mut self, m: &Metrics, overlay: bool, ds: &Ds) -> AnyElement {
        let len = |token| f32::from(ds.len(token));
        let (top, bottom) = if m.compact {
            (
                len(Length::SpaceLg),
                COMPACT_BOTTOM.max(len(Length::SafeAreaBottom) + len(Length::Space2xl)),
            )
        } else {
            (len(Length::SpaceXl), BOTTOM)
        };
        let bottom = if overlay {
            m.overlay_bottom + len(Length::SpaceXl)
        } else {
            bottom
        };
        let stack = Stack::new()
            .gap(panel::page_gap(m.compact))
            .children(std::mem::take(&mut self.children));
        div()
            .w_full()
            .pt(px(top))
            .pb(px(bottom))
            .child(
                PageContainer::new()
                    .width(self.width)
                    .child(panel::Backdrop::new(self.background.is_some(), stack)),
            )
            .into_any_element()
    }

    /// The layer behind the content, with the calm veil over it.
    fn backdrop(&mut self, ds: &Ds) -> Option<AnyElement> {
        let calm = self.treatment == BackgroundTreatment::Calm;
        self.background.take().map(|layer| {
            let veil = calm.then(|| {
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .bg(ds.color(Color::ManagementPageVeil))
            });
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .overflow_hidden()
                .child(layer)
                .children(veil)
                .into_any_element()
        })
    }
}

impl RenderOnce for ManagementPage {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track((self.id.clone(), "page"), window, cx);
        let (width, height) = (f32::from(size.width), f32::from(size.height));
        let layout = aside::layout(&self.id, (self.aside.is_some(), width), window, cx);
        let shown = shown(self.aside.is_some(), layout, self.aside_float_open);
        let docked = shown == Some(AsideLayout::Docked);
        let m = Metrics::of(&self, docked, window, Ds::get(cx));
        let overlay = self.footer.is_some() && self.placement == FooterPlacement::Overlay;
        let content = self.content(&m, overlay, Ds::get(cx));
        let scroll = ScrollArea::new((self.id.clone(), "scroll"))
            .fill()
            .child(content);
        let aside = self.aside.take().zip(shown).map(|(content, layout)| {
            let slot = aside::Slot {
                id: self.id.clone(),
                content,
                layout,
                label: self.aside_label.take(),
                bottom: m.overlay_bottom,
            };
            aside::render(&slot, (width, height), window, cx)
        });
        let ds = Ds::get(cx);
        let backdrop = self.backdrop(ds);
        let footer = self.footer.take().map(|footer| {
            if overlay {
                scope::scoped(
                    Spec {
                        conversation: Some(m.column(width, self.reserve)),
                        ..Spec::default()
                    },
                    footer,
                )
                .into_any_element()
            } else {
                div().flex_none().min_w_0().child(footer).into_any_element()
            }
        });
        div()
            .id(self.id.clone())
            .relative()
            .size_full()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .text_color(ds.color(Color::TextPrimary))
            .children(backdrop)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_auto()
                    .min_w_0()
                    .min_h_0()
                    .pr(px(m.keep_out))
                    .child(scroll),
            )
            .children(footer)
            .children(aside)
            .child(recorder)
    }
}
