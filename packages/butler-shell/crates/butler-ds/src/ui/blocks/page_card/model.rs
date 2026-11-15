//! What a PageCard reports and the rules behind it: who holds the tab, the page's bounds with the
//! radius the page takes, and where a fixed-size page sits in its area.
use gpui::{Bounds, Pixels};

/// Who holds the tab: nobody, Butler (rotating riso edge), you (strong neutral edge), an approval
/// (static amber).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PageCardHolder {
    #[default]
    None,
    Butler,
    User,
    Waiting,
}

/// Where the page is, for the engine that draws it (`PageCardBounds` of PageCard.tsx, without
/// the native-view occlusion). `bounds` are window pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageCardBounds {
    pub bounds: Bounds<Pixels>,
    /// Page pixels per layout pixel (1 unless a fixed-size page is fitted).
    pub scale: f32,
    /// The one radius the page takes for its corners.
    pub radius: Pixels,
    /// There is a page to place: not hidden, not a Butler page, with an area.
    pub visible: bool,
}

/// A rectangle in layout pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

/// Which page corners meet a corner of the card surface: the page's sides reach the area's
/// sides, and its top reaches the surface top or its bottom reaches the area bottom.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CornerContact {
    pub top: bool,
    pub bottom: bool,
}

/// `pageRadius` of PageCard.tsx, as the contacts of the corners: `radius` is the card's inner
/// radius, `area` the content area, `page` the page rect, `surface_top` where the surface starts
/// (under an empty reserved band row, the row's bottom).
pub fn corner_contact(radius: f32, area: Rect, page: Rect, surface_top: f32) -> CornerContact {
    let tolerance = radius;
    let sides = page.left - area.left <= tolerance && area.right - page.right <= tolerance;
    CornerContact {
        top: radius > 0. && sides && page.top - surface_top <= tolerance,
        bottom: radius > 0. && sides && area.bottom - page.bottom <= tolerance,
    }
}

/// `pageRadius`: the native view takes one radius for all four corners, so it is the inner
/// radius where a page corner meets a surface corner, else 0.
pub fn page_radius(radius: f32, area: Rect, page: Rect, surface_top: f32) -> f32 {
    let contact = corner_contact(radius, area, page, surface_top);
    if contact.top || contact.bottom {
        radius
    } else {
        0.
    }
}

/// A fixed-size page fitted into `area` (`object-fit: contain`, centred): its rect and scale.
pub fn fit_page(area: Rect, width: f32, height: f32) -> (Rect, f32) {
    let (aw, ah) = (area.right - area.left, area.bottom - area.top);
    if width <= 0. || height <= 0. || aw <= 0. || ah <= 0. {
        return (area, 1.);
    }
    let scale = (aw / width).min(ah / height);
    let (w, h) = (width * scale, height * scale);
    let left = area.left + (aw - w) / 2.;
    let top = area.top + (ah - h) / 2.;
    (
        Rect {
            left,
            top,
            right: left + w,
            bottom: top + h,
        },
        scale,
    )
}
