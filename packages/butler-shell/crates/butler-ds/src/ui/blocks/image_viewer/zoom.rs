//! Zoom and pan of one picture (zoom.ts): fitted at 1x, up to 4x. The view is a scale and a
//! pan offset from the picture's fitted centre; `clamp` keeps the zoomed picture covering its
//! fitted box, `zoom_at` keeps a point still.

pub(super) const MIN_ZOOM: f32 = 1.;
pub(super) const MAX_ZOOM: f32 = 4.;
/// Zoom buttons and the +/- keys step by this factor.
pub(super) const ZOOM_STEP: f32 = 1.5;
/// A double click zooms to this level at the point (or back to fit).
pub(super) const DOUBLE_CLICK_ZOOM: f32 = 2.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct View {
    pub(super) scale: f32,
    pub(super) x: f32,
    pub(super) y: f32,
}

pub(super) const FIT: View = View {
    scale: 1.,
    x: 0.,
    y: 0.,
};

/// No panning past the picture's edges.
pub(super) fn clamp(view: View, width: f32, height: f32) -> View {
    let scale = view.scale.clamp(MIN_ZOOM, MAX_ZOOM);
    if scale <= 1. {
        return FIT;
    }
    let max_x = (scale - 1.) * width / 2.;
    let max_y = (scale - 1.) * height / 2.;
    View {
        scale,
        x: view.x.clamp(-max_x, max_x),
        y: view.y.clamp(-max_y, max_y),
    }
}

/// Zooms to `scale` keeping the point (an offset from the picture's centre) still.
pub(super) fn zoom_at(view: View, scale: f32, point: (f32, f32)) -> View {
    let ratio = scale / view.scale;
    View {
        scale,
        x: point.0 - (point.0 - view.x) * ratio,
        y: point.1 - (point.1 - view.y) * ratio,
    }
}
