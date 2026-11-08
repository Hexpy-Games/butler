//! Shared logo and halftone geometry for window and live-canvas painting.
use super::geometry::{self, CENTER, DESIGN, RING_R, RING_W, morph_sd, rest_outline};
use super::halftone::{Frame, lattice, mis_of, pitch_of, size_class};
use gpui::{Bounds, Corners, Hsla, Pixels, Window, point, px, size};

/// Shared painting of the static logo and the live canvas, including ink-layer opacity.
pub trait Painter {
    fn paint_quad(&mut self, quad: gpui::PaintQuad);
    fn paint_path(&mut self, path: gpui::Path<Pixels>, color: Hsla);
    fn layer(&mut self, area: Bounds<Pixels>, alpha: f32, paint: impl FnOnce(&mut Self));
}

impl Painter for Window {
    fn paint_quad(&mut self, quad: gpui::PaintQuad) {
        self.paint_quad(quad);
    }
    fn paint_path(&mut self, path: gpui::Path<Pixels>, color: Hsla) {
        self.paint_path(path, color);
    }
    fn layer(&mut self, area: Bounds<Pixels>, alpha: f32, paint: impl FnOnce(&mut Self)) {
        self.with_motion(
            gpui::LayerMotion {
                duration_ms: 1,
                opacity: (alpha, alpha),
                ..gpui::LayerMotion::NONE
            },
            area,
            paint,
        );
    }
}

impl Painter for gpui::LiveCanvas {
    fn paint_quad(&mut self, quad: gpui::PaintQuad) {
        self.paint_quad(quad);
    }
    fn paint_path(&mut self, path: gpui::Path<Pixels>, color: Hsla) {
        self.paint_path(path, color);
    }
    fn layer(&mut self, area: Bounds<Pixels>, alpha: f32, paint: impl FnOnce(&mut Self)) {
        let bounds = area.scale(self.scale_factor);
        let boundary = gpui::FilterBoundary {
            order: 0,
            bounds,
            content_mask: gpui::ContentMask {
                bounds,
                ..Default::default()
            },
            corner_radii: Default::default(),
            corner_smoothing: 0.,
            filters: Default::default(),
            opacity: alpha,
            scale: 1.,
            scale_origin: Default::default(),
            motion: gpui::LayerMotion::NONE,
            motion_bounds: bounds,
            is_start: true,
            inline: false,
        };
        self.scene.insert_primitive(boundary.clone());
        paint(self);
        self.scene.insert_primitive(gpui::FilterBoundary {
            is_start: false,
            ..boundary
        });
    }
}

/// What a frame paints.
#[derive(Clone, Copy)]
pub(super) struct Painting {
    pub(super) m: f32,
    pub(super) t: f32,
    pub(super) key: Hsla,
    pub(super) blue: Hsla,
    pub(super) pink: Hsla,
}

/// The square the mark is drawn in, and the scale from design units.
pub(super) fn square(bounds: Bounds<Pixels>) -> (Bounds<Pixels>, f32) {
    let side = bounds.size.width.min(bounds.size.height);
    let origin = point(
        bounds.origin.x + (bounds.size.width - side) / 2.,
        bounds.origin.y + (bounds.size.height - side) / 2.,
    );
    (
        Bounds::new(origin, size(side, side)),
        f32::from(side) / DESIGN,
    )
}

fn polygon(
    window: &mut impl Painter,
    points: impl Iterator<Item = gpui::Point<Pixels>>,
    color: Hsla,
) {
    let mut path = gpui::PathBuilder::fill();
    for (n, p) in points.enumerate() {
        if n == 0 {
            path.move_to(p);
        } else {
            path.line_to(p);
        }
    }
    path.close();
    if let Ok(path) = path.build() {
        window.paint_path(path, color);
    }
}

/// The exact logo: the traced ribbon and the ring.
pub(super) fn paint_rest(window: &mut impl Painter, area: Bounds<Pixels>, k: f32, color: Hsla) {
    let rays = rest_outline();
    let centre = area.center();
    polygon(
        window,
        rays.iter().enumerate().map(|(n, r)| {
            let angle = n as f32 / rays.len() as f32 * std::f32::consts::TAU;
            point(
                centre.x + px(angle.cos() * r * k),
                centre.y + px(angle.sin() * r * k),
            )
        }),
        color,
    );
}

pub(super) fn paint_ring(window: &mut impl Painter, area: Bounds<Pixels>, k: f32, color: Hsla) {
    crate::ui::arc::ring(window, area.center(), RING_R * k, RING_W * k, color);
}

/// One screen of dots (`ink` 0 key, 1 blue, 2 pink), `(dx, dy)` design units off register.
fn paint_dots(
    window: &mut impl Painter,
    area: Bounds<Pixels>,
    k: f32,
    frame: &Frame,
    ink: usize,
    offset: (f32, f32),
    color: Hsla,
) {
    let class = size_class(f32::from(area.size.width));
    let layer = &lattice(class)[ink];
    // The clip to the outline of the early morph: dots whose centre is outside it are dropped.
    let margin = (frame.m < CLIP_RELEASE).then(|| 3. * pitch_of(class) * frame.m);
    let origin = area.origin;
    for cell in &layer.cells {
        let r = frame.dot_radius(layer, cell, ink);
        if r <= 0. {
            continue;
        }
        if let Some(margin) = margin {
            let dc = (cell.x - CENTER).hypot(cell.y - CENTER);
            if morph_sd(geometry::sd_ribbon(cell.x, cell.y), dc, frame.m, frame.br) > margin {
                continue;
            }
        }
        let (x, y) = (cell.x + offset.0, cell.y + offset.1);
        let bounds = Bounds::new(
            point(origin.x + px((x - r) * k), origin.y + px((y - r) * k)),
            size(px(2. * r * k), px(2. * r * k)),
        );
        window.paint_quad(
            gpui::PaintQuad::new(bounds)
                .background(color)
                .corner_radii(Corners::all(px(r * k))),
        );
    }
}

/// Progress past which the clip trims nothing. // DS: morph-outline.ts:56
const CLIP_RELEASE: f32 = 0.6;

/// The halftone moon: the riso screens off register, the key screen on top, then the ring.
pub(super) fn paint_screen(
    window: &mut impl Painter,
    area: Bounds<Pixels>,
    look: &Painting,
    ink: usize,
) {
    let k = f32::from(area.size.width) / DESIGN;
    let frame = Frame::new(look.m, look.t);
    let class = size_class(f32::from(area.size.width));
    let (t, m) = (look.t, look.m);
    // Misregistration opens with the morph: the inks start in register on the key dots.
    let mis = (7. + 4. * (t * 1.2).sin()) * mis_of(class) * m;
    let mis2 = (-5. + 3. * (t * 0.95).cos()) * mis_of(class) * m;
    // Cross-fade the last halftone edge into the exact rest logo below M = 0.05.
    let blend = (m / 0.05).min(1.);
    match ink {
        1 if m > 0.001 => paint_dots(
            window,
            area,
            k,
            &frame,
            1,
            (mis, mis2),
            Hsla {
                alpha: 1.,
                ..look.blue
            },
        ),
        2 if m > 0.001 => paint_dots(
            window,
            area,
            k,
            &frame,
            2,
            (-mis2, mis * 0.6),
            Hsla {
                alpha: 1.,
                ..look.pink
            },
        ),
        0 => {
            if blend < 1. {
                paint_rest(
                    window,
                    area,
                    k,
                    Hsla {
                        alpha: look.key.alpha * (1. - blend),
                        ..look.key
                    },
                );
            }
            paint_dots(
                window,
                area,
                k,
                &frame,
                0,
                (0., 0.),
                Hsla {
                    alpha: blend,
                    ..look.key
                },
            );
            paint_ring(window, area, k, look.key);
        }
        _ => {}
    }
}
