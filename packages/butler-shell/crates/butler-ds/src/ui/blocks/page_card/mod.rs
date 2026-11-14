//! DS PageCard (PageCard.tsx / PageCard.module.css): the web page as one elevated card inside
//! BrowserPane. It shows who holds the tab, a PageBand, a 2px load line and, for Butler's fixed
//! 1280x800 tabs, the page fitted to the card's width with the card ending under it and the
//! scale noted below. With `reserve_band` the band row is always there, so a band arriving,
//! changing or leaving never moves the page.
//!
//! Why the native-view props are gone: Electron lays a native view over the card, so React needs
//! `NativeViewSlot`, a still of the page (`stillSrc`, `stillAlt`) while a DOM layer covers it
//! (`covered`, `occluderSelector`, `onOcclusion`). Here the page is a texture the shell paints
//! inside the scene, in the same z-order as the DS around it: nothing covers it, so none of
//! that exists. `page` is that surface; it is laid out exactly in the content area (or the
//! fitted viewport rect) and `on_bounds_change` tells the engine the rect and radius to size its
//! view to.
mod edge;
mod model;
mod parts;

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Hsla, InteractiveElement as _, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, Size, Styled as _, Window, canvas, div, px,
};

pub(in crate::ui::blocks) use edge::{Ring, corner_caps, inks, riso_fill, riso_ring};
pub use model::{
    CornerContact, PageCardBounds, PageCardHolder, Rect, corner_contact, fit_page, page_radius,
};

use super::measure;
use super::page_band::PageBand;
use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::scroll::ScrollArea;
use crate::ui::typo::{Role, Tone, Typo};

type BoundsHandler = Rc<dyn Fn(PageCardBounds, &mut Window, &mut App)>;

/// What the BrowserPane around a card sets for it (the `--page-card-*` variables of `.stage`).
#[derive(Clone, Copy)]
pub(in crate::ui::blocks) struct PaneFrame {
    /// `--page-card-radius`: 0 beside the window frame, the shell card radius in the cards frame.
    pub radius: Pixels,
    /// `--browser-card-shadow` is `--shell-page-shadow` (the cards frame).
    pub page_shadow: bool,
    /// What lies behind a rounded corner of the page.
    pub backdrop: Hsla,
}

#[derive(IntoElement)]
pub struct PageCard {
    id: gpui::ElementId,
    holder: PageCardHolder,
    band: Option<PageBand>,
    reserve_band: bool,
    loading: Option<f32>,
    loading_label: SharedString,
    viewport: Option<Size<f32>>,
    page: Option<AnyElement>,
    on_bounds_change: Option<BoundsHandler>,
    hidden: bool,
    children: Vec<AnyElement>,
    internal: Option<AnyElement>,
    overlay: Option<AnyElement>,
    panel_id: Option<SharedString>,
    pane: Option<PaneFrame>,
}

impl PageCard {
    pub fn new(id: impl Into<gpui::ElementId>) -> Self {
        Self {
            id: id.into(),
            holder: PageCardHolder::None,
            band: None,
            reserve_band: false,
            loading: None,
            loading_label: "Loading".into(),
            viewport: None,
            page: None,
            on_bounds_change: None,
            hidden: false,
            children: Vec::new(),
            internal: None,
            overlay: None,
            panel_id: None,
            pane: None,
        }
    }

    pub fn holder(mut self, holder: PageCardHolder) -> Self {
        self.holder = holder;
        self
    }

    /// A PageBand attached to the card's top. It is a `PageBand` (not any element) so the card
    /// can take the line off its bottom: band and page are one surface.
    pub fn band(mut self, band: PageBand) -> Self {
        self.band = Some(band);
        self
    }

    /// Keep one band row (`--browser-band-height`) whether or not a band shows, so a band
    /// arriving, changing tone or leaving never moves the page. With no band the row is empty
    /// and the card surface starts under it.
    pub fn reserve_band(mut self) -> Self {
        self.reserve_band = true;
        self
    }

    /// Page load progress (0 to 100): a 2px line on the card's top edge. Omit when loaded.
    pub fn loading(mut self, progress: f32) -> Self {
        self.loading = Some(progress);
        self
    }

    pub fn loading_label(mut self, label: impl Into<SharedString>) -> Self {
        self.loading_label = label.into();
        self
    }

    /// Butler's tabs keep a fixed page size (1280x800): the page fits the card's width and the
    /// card ends with it, its scale noted below. Only a stage too short for the page's aspect
    /// letterboxes it at the sides.
    pub fn viewport(mut self, size: Size<f32>) -> Self {
        self.viewport = Some(size);
        self
    }

    /// The page surface the shell draws (later the CEF frame), laid out exactly in the content
    /// area or the fitted viewport rect.
    pub fn page(mut self, page: impl IntoElement) -> Self {
        self.page = Some(page.into_any_element());
        self
    }

    /// Where the page is and the radius it takes; called only when the value changes.
    pub fn on_bounds_change(
        mut self,
        handler: impl Fn(PageCardBounds, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_bounds_change = Some(Rc::new(handler));
        self
    }

    /// No page (no tab, crashed): the children show instead.
    pub fn hidden(mut self, hidden: bool) -> Self {
        self.hidden = hidden;
        self
    }

    /// A Butler page the shell draws (new tab, library). The slot scrolls it: pass the page
    /// without a ScrollArea of its own.
    pub fn internal(mut self, internal: impl IntoElement) -> Self {
        self.internal = Some(internal.into_any_element());
        self
    }

    /// Layers over the page area, e.g. a SelectionBar.
    pub fn overlay(mut self, overlay: impl IntoElement) -> Self {
        self.overlay = Some(overlay.into_any_element());
        self
    }

    /// Id of the page area, for the TabStrip `panelId`.
    pub fn panel_id(mut self, id: impl Into<SharedString>) -> Self {
        self.panel_id = Some(id.into());
        self
    }

    pub(in crate::ui::blocks) fn in_pane(mut self, frame: PaneFrame) -> Self {
        self.pane = Some(frame);
        self
    }
}

impl ParentElement for PageCard {
    /// DS content shown instead of the page: the empty and crashed states.
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The lengths one card is laid out with.
struct Metrics {
    radius: Pixels,
    hairline: Pixels,
    /// Where the surface starts: under an empty reserved band row.
    top: Pixels,
    /// The scale note's row under a fixed page.
    note: Pixels,
}

impl PageCard {
    fn metrics(&self, ds: &Ds) -> Metrics {
        let radius = self
            .pane
            .map_or_else(|| ds.len(Length::PageCardRadius), |pane| pane.radius);
        let empty_row = self.reserve_band && self.band.is_none();
        let note = if self.fixed_page() {
            ds.len(Length::SpaceSm) + ds.len(Length::TypoCaptionLineHeightTight)
        } else {
            px(0.)
        };
        Metrics {
            radius,
            hairline: ds.len(Length::BorderHairline),
            top: if empty_row {
                ds.len(Length::BrowserBandHeight)
            } else {
                px(0.)
            },
            note,
        }
    }

    fn fixed_page(&self) -> bool {
        self.viewport.is_some() && self.internal.is_none()
    }

    /// The page area: the native view's rect, and what overlays position in.
    fn content(
        &mut self,
        m: &Metrics,
        window: &mut Window,
        cx: &mut App,
    ) -> (AnyElement, Option<SharedString>) {
        let (seen, recorder) = measure::track((self.id.clone(), "area"), window, cx);
        let viewport = self.viewport;
        let mut area = div()
            .id(self.panel_id.clone().map_or_else(
                || gpui::ElementId::from((self.id.clone(), "content")),
                gpui::ElementId::from,
            ))
            .relative()
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .flex_auto();
        if let (Some(view), true) = (viewport, self.fixed_page()) {
            area = area
                .w_full()
                .flex_initial()
                .aspect_ratio(view.width / view.height);
        }
        if self.reserve_band && self.band.is_none() {
            // `.card:has(> .inner > .bandRow:empty) .content`: it carries the card's top corners.
            area = area.overflow_hidden();
        }
        let shown_scale = parts::note_scale(seen, viewport);
        let body = parts::body(self, seen, cx);
        let report = self.reporter(m, window, cx);
        let note = viewport
            .zip(shown_scale)
            .filter(|_| self.fixed_page() && !self.hidden)
            .map(|(view, scale)| {
                SharedString::from(format!(
                    "{} × {} · {}%",
                    view.width.round(),
                    view.height.round(),
                    (scale * 100.).round()
                ))
            });
        let area = area
            .child(body)
            .child(report)
            .children(
                self.overlay
                    .take()
                    .map(|layer| div().absolute().top_0().left_0().size_full().child(layer)),
            )
            .child(recorder);
        (area.into_any_element(), note)
    }

    /// Reports the page's rect and radius when they change, and caps the page's rounded corners.
    fn reporter(&self, m: &Metrics, window: &mut Window, cx: &mut App) -> AnyElement {
        let last =
            window.use_keyed_state(
                (self.id.clone(), "bounds"),
                cx,
                |_, _| None::<PageCardBounds>,
            );
        let ds = Ds::get(cx);
        let spec = parts::Report {
            viewport: self.viewport,
            visible: !self.hidden && self.internal.is_none(),
            radius: f32::from((m.radius - m.hairline).max(px(0.))),
            band_height: f32::from(ds.len(Length::BrowserBandHeight)),
            band_shown: self.band.is_some(),
            backdrop: self
                .pane
                .map_or_else(|| ds.color(Color::BrowserPaneBg), |pane| pane.backdrop),
            handler: self.on_bounds_change.clone(),
        };
        canvas(
            |bounds: Bounds<Pixels>, _, _| bounds,
            move |_, area, window, cx| parts::report(&spec, &last, area, window, cx),
        )
        .absolute()
        .size_full()
        .into_any_element()
    }
}

impl RenderOnce for PageCard {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let m = self.metrics(ds);
        let fixed = self.fixed_page();
        let ui_scale = ds.number(Number::UiScale).max(f32::EPSILON);
        let edge_radius = m.radius + m.hairline / ui_scale;
        let surface = parts::surface(&self, &m, ds);
        let (content, note) = self.content(&m, window, cx);
        let edge = parts::edge(&self, &m, edge_radius, cx);
        let inner = parts::inner(&mut self, &m, content, fixed, cx);
        let ds = Ds::get(cx);
        let mut card = div()
            .id(self.id.clone())
            .relative()
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .rounded(m.radius);
        card = if fixed {
            card.flex_initial()
        } else {
            card.flex_auto()
        };
        // The note's row under the card surface (`padding-bottom` in the CSS: gpui places
        // absolute boxes inside padding, so it is a row of its own).
        let note_row = fixed.then(|| {
            div()
                .flex()
                .flex_none()
                .justify_center()
                .items_end()
                .h(m.note)
                .text_size(ds.len(Length::FontSize1))
                .line_height(ds.len(Length::TypoCaptionLineHeightTight))
                .children(
                    note.map(|text| Typo::new(Role::Text, text).tone(Tone::Tertiary).tabular()),
                )
        });
        card.child(surface)
            .child(inner)
            .children(edge)
            .children(note_row)
    }
}

/// The `internal` slot: a Butler page on the workspace surface that scrolls.
pub(in crate::ui::blocks) fn internal_slot(
    id: gpui::ElementId,
    page: AnyElement,
    ds: &Ds,
) -> AnyElement {
    div()
        .min_h_0()
        .flex_auto()
        .overflow_hidden()
        .bg(ds.color(Color::WorkspaceBg))
        .child(ScrollArea::new((id, "internal")).fill().child(page))
        .into_any_element()
}
