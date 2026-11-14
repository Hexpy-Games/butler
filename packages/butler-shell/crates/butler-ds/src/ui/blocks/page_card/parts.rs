//! The layers of a PageCard: surface and shadow, holder edge, the inner box with the load line
//! and the band row, the page slot and the reporter of the page's rect.
use gpui::{
    AnyElement, App, Bounds, BoxShadow, Corners, Div, Edges, Entity, Hsla, IntoElement,
    ParentElement as _, Pixels, SharedString, Size, Styled as _, Window, div, point, px, size,
};

use super::edge::{Ring, corner_caps, inks, riso_ring};
use super::model::{PageCardBounds, PageCardHolder, Rect, corner_contact, fit_page};
use super::{BoundsHandler, Metrics, PageCard, internal_slot};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::blocks::progress_meter::ProgressMeter;
use crate::ui::context::Ds;
use crate::ui::convert;

/// The scale the note reads: the fitted page's width over the page's width, once measured.
pub(super) fn note_scale(seen: Size<Pixels>, viewport: Option<Size<f32>>) -> Option<f32> {
    let view = viewport?;
    let (w, h) = (f32::from(seen.width), f32::from(seen.height));
    (w > 0. && h > 0.).then(|| {
        let area = Rect {
            left: 0.,
            top: 0.,
            right: w,
            bottom: h,
        };
        fit_page(area, view.width, view.height).1
    })
}

/// The page area's content: a Butler page, the DS content of a hidden page, or the page.
pub(super) fn body(card: &mut PageCard, seen: Size<Pixels>, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    if let Some(page) = card.internal.take() {
        return internal_slot((card.id.clone(), "slot").into(), page, ds);
    }
    let children = std::mem::take(&mut card.children);
    let page = card.page.take();
    if card.hidden || page.is_none() {
        return div()
            .flex()
            .flex_col()
            .flex_auto()
            .min_h_0()
            .children(children)
            .into_any_element();
    }
    page_slot(card, page, seen, ds)
}

/// `.slot`: the page fills the area, or is fitted in it over the `--muted` letterbox.
fn page_slot(card: &PageCard, page: Option<AnyElement>, seen: Size<Pixels>, ds: &Ds) -> AnyElement {
    let slot = div().absolute().top_0().left_0().size_full();
    let Some(view) = card.viewport else {
        return slot.children(page).into_any_element();
    };
    let slot = slot.bg(ds.color(Color::Muted));
    let (w, h) = (f32::from(seen.width), f32::from(seen.height));
    if w <= 0. || h <= 0. {
        return slot.into_any_element();
    }
    let area = Rect {
        left: 0.,
        top: 0.,
        right: w,
        bottom: h,
    };
    let (fit, _) = fit_page(area, view.width, view.height);
    slot.child(
        div()
            .absolute()
            .left(px(fit.left))
            .top(px(fit.top))
            .w(px(fit.right - fit.left))
            .h(px(fit.bottom - fit.top))
            .overflow_hidden()
            .children(page),
    )
    .into_any_element()
}

/// What the reporter needs, owned by its paint closure.
pub(super) struct Report {
    pub viewport: Option<Size<f32>>,
    pub visible: bool,
    pub radius: f32,
    pub band_height: f32,
    pub band_shown: bool,
    pub backdrop: Hsla,
    pub handler: Option<BoundsHandler>,
}

/// Works out the page's rect, scale and radius in window pixels; tells the owner when they
/// changed, and caps the page's rounded corners.
pub(super) fn report(
    spec: &Report,
    last: &Entity<Option<PageCardBounds>>,
    area: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    let f = f32::from;
    let rect = Rect {
        left: f(area.origin.x),
        top: f(area.origin.y),
        right: f(area.origin.x + area.size.width),
        bottom: f(area.origin.y + area.size.height),
    };
    let (page, scale) = spec
        .viewport
        .map_or((rect, 1.), |view| fit_page(rect, view.width, view.height));
    // Under a band the surface starts at the band's top; under an empty row, at the area's.
    let band = if spec.band_shown {
        spec.band_height
    } else {
        0.
    };
    let contact = corner_contact(spec.radius, rect, page, rect.top - band);
    let radius = if contact.top || contact.bottom {
        spec.radius
    } else {
        0.
    };
    let bounds = Bounds::new(
        point(px(page.left), px(page.top)),
        size(px(page.right - page.left), px(page.bottom - page.top)),
    );
    let current = PageCardBounds {
        bounds,
        scale,
        radius: px(radius),
        visible: spec.visible && bounds.size.width > px(0.) && bounds.size.height > px(0.),
    };
    if last.read(cx).as_ref() != Some(&current) {
        last.update(cx, |last, _| *last = Some(current));
        if let Some(handler) = &spec.handler {
            handler(current, window, cx);
        }
    }
    if current.visible {
        let (top, bottom) = (
            px(if contact.top { radius } else { 0. }),
            px(if contact.bottom { radius } else { 0. }),
        );
        corner_caps(window, bounds, [top, top, bottom, bottom], spec.backdrop);
    }
}

fn shadows(layers: &[(f32, f32, f32, f32, Hsla)]) -> Vec<BoxShadow> {
    layers
        .iter()
        .map(|&(x, y, blur, spread, color)| BoxShadow {
            color: color.into(),
            offset: point(px(x), px(y)),
            blur_radius: px(blur),
            spread_radius: px(spread),
            inset: false,
        })
        .collect()
}

/// `::before`: the surface and its shadow, which start under an empty reserved row.
pub(super) fn surface(card: &PageCard, m: &Metrics, ds: &Ds) -> Div {
    let token = if card.pane.is_some_and(|pane| pane.page_shadow) {
        Shadow::ShellPageShadow
    } else {
        Shadow::BrowserCardShadow
    };
    let plain = convert::box_shadows(ds.tokens().shadow(token), ds.tokens());
    let shadow = match card.holder {
        // BrowserPane draws Butler's edge itself and sets the glow to the plain shadow.
        PageCardHolder::Butler if card.pane.is_none() => shadows(&[
            (
                0.,
                0.,
                0.,
                4.,
                convert::with_alpha(ds.color(Color::ButlerInkPurple), 0.1),
            ),
            (
                0.,
                8.,
                32.,
                0.,
                convert::with_alpha(ds.color(Color::ButlerInkBlue), 0.22),
            ),
        ]),
        PageCardHolder::Waiting => {
            let mut layers = shadows(&[(0., 0., 0., 4., ds.color(Color::ColorWarningBg))]);
            layers.extend(plain);
            layers
        }
        _ => plain,
    };
    div()
        .absolute()
        .top(m.top)
        .left_0()
        .right_0()
        .bottom(m.note)
        .rounded(m.radius)
        .bg(ds.color(Color::SurfaceRaised))
        .shadow(shadow)
}

/// `::after`: the holder's edge, drawn over the border and one hairline outside it.
pub(super) fn edge(card: &PageCard, m: &Metrics, radius: Pixels, cx: &App) -> Option<AnyElement> {
    let ds = Ds::get(cx);
    let strong = ds.len(Length::BorderWidthStrong);
    let frame = div()
        .absolute()
        .top(m.top - m.hairline)
        .left(-m.hairline)
        .right(-m.hairline)
        .bottom(m.note - m.hairline)
        .rounded(radius);
    Some(match card.holder {
        PageCardHolder::Butler if card.pane.is_none() => {
            let ring = Ring {
                radii: Corners::all(radius),
                widths: Edges::all(strong),
                inks: inks(ds),
            };
            frame.child(riso_ring(ring)).into_any_element()
        }
        PageCardHolder::User => frame
            .border(px(1.5)) // DS: PageCard.module.css:138
            .border_color(ds.color(Color::LineStrong))
            .into_any_element(),
        PageCardHolder::Waiting => frame
            .border(strong)
            .border_color(convert::with_alpha(ds.color(Color::ColorWarningText), 0.7))
            .into_any_element(),
        _ => return None,
    })
}

/// `.inner`: clips, keeps a transparent hairline so the content area never moves.
pub(super) fn inner(
    card: &mut PageCard,
    m: &Metrics,
    content: AnyElement,
    fixed: bool,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let band_height = ds.len(Length::BrowserBandHeight);
    let empty_row = card.reserve_band && card.band.is_none();
    let band = card
        .band
        .take()
        .map(super::super::page_band::PageBand::flush);
    let band = if card.reserve_band {
        Some(
            div()
                .flex()
                .flex_col()
                .flex_none()
                .h(band_height)
                .overflow_hidden()
                .children(band)
                .into_any_element(),
        )
    } else {
        band.map(IntoElement::into_any_element)
    };
    let el = div()
        .relative()
        .flex()
        .flex_col()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .border(m.hairline)
        .border_color(gpui::transparent_black())
        .rounded(m.radius);
    let el = if fixed {
        el.flex_initial()
    } else {
        el.flex_auto()
    };
    let line = card.loading.map(|progress| {
        let label: SharedString = card.loading_label.clone();
        let line = div().absolute();
        let line = if empty_row {
            // No band: the line runs along the top of the surface, between the card corners.
            line.left(m.radius)
                .right(m.radius)
                .top(m.top - ds.len(Length::BorderWidthStrong))
        } else {
            line.left_0().right_0().top_0()
        };
        line.child(
            ProgressMeter::new((card.id.clone(), "load"), progress)
                .thin()
                .label(label),
        )
    });
    // The line paints over the band and the page (`z-index: 2`).
    el.children(band)
        .child(content)
        .children(line)
        .into_any_element()
}
