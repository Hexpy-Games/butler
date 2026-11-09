//! MaskCanvas painting and pointer input: the picture, the paint layer over it, the painted
//! region's wash and result, and the brush outline. Painting is input-driven: the layer is
//! redrawn only when a pointer event changes it, there is no frame loop.
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    App, BorderStyle, Bounds, ContentMask, Corners, DispatchPhase, Edges, Entity, Hsla,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point,
    RenderImage, Window, point, px, size,
};

use super::raster::Coverage;
use super::state::MaskCanvasState;
use super::{ChangeHandler, MaskStroke, MaskTool};

/// What one paint draws.
pub(super) struct Frame {
    pub(super) picture: Option<Arc<RenderImage>>,
    /// The paint layer; `None` while nothing is painted or the mask is hidden (compare).
    pub(super) layer: Option<Arc<RenderImage>>,
    /// The generating wash over the painted region.
    pub(super) wash: Option<Arc<Coverage>>,
    /// The edited picture, shown inside the painted region only.
    pub(super) result: Option<(Arc<RenderImage>, Arc<Coverage>)>,
    pub(super) radius: Pixels,
    pub(super) accent: Hsla,
    pub(super) ring: Hsla,
    pub(super) tool: MaskTool,
    /// Brush diameter in screen px.
    pub(super) brush: f32,
    pub(super) hover: Option<Point<Pixels>>,
    pub(super) painting: bool,
}

/// `.frame`: the picture's shape contained in `area`, centred.
pub(super) fn fit(area: Bounds<Pixels>, width: u32, height: u32) -> Bounds<Pixels> {
    let (aw, ah) = (f32::from(area.size.width), f32::from(area.size.height));
    let (pw, ph) = (width.max(1) as f32, height.max(1) as f32);
    let scale = (aw / pw).min(ah / ph);
    let (w, h) = (pw * scale, ph * scale);
    Bounds::new(
        point(
            area.origin.x + px((aw - w) / 2.),
            area.origin.y + px((ah - h) / 2.),
        ),
        size(px(w), px(h)),
    )
}

/// The rectangle of a run of the painted region inside `frame`.
fn run_bounds(frame: Bounds<Pixels>, [left, top, right, bottom]: [f32; 4]) -> Bounds<Pixels> {
    let (w, h) = (f32::from(frame.size.width), f32::from(frame.size.height));
    Bounds::new(
        point(frame.origin.x + px(w * left), frame.origin.y + px(h * top)),
        size(px(w * (right - left)), px(h * (bottom - top))),
    )
}

impl Frame {
    pub(super) fn paint(&self, frame: Bounds<Pixels>, window: &mut Window) {
        let corners = Corners::all(self.radius);
        if let Some(picture) = &self.picture {
            window
                .paint_image(frame, frame, corners, 0., picture.clone(), 0, false)
                .ok();
        }
        if let Some(layer) = &self.layer {
            // ANIM-MIGRATE(layer opacity fade, --motion-fast, when compare hides the mask)
            window
                .paint_image(frame, frame, corners, 0., layer.clone(), 0, false)
                .ok();
        }
        let mask = ContentMask {
            bounds: frame,
            ..ContentMask::default()
        };
        window.with_content_mask(Some(mask), |window| {
            self.paint_region(frame, window);
            self.paint_cursor(frame, window);
        });
    }

    /// The wash and the result, each clipped to the painted region.
    fn paint_region(&self, frame: Bounds<Pixels>, window: &mut Window) {
        // ANIM-MIGRATE(the light band sweeping through the painted region while generating;
        // the end state is the still wash)
        if let Some(region) = &self.wash {
            let tint = Hsla {
                alpha: 0.3, // DS: MaskCanvas.module.css:85
                ..self.accent
            };
            for run in &region.runs {
                window.paint_quad(
                    PaintQuad::new(run_bounds(frame, region.fractions(run))).background(tint),
                );
            }
        }
        // ANIM-MIGRATE(the result fades in over --motion-deliberate; the end state is shown)
        if let Some((result, region)) = &self.result {
            for run in &region.runs {
                let cell = run_bounds(frame, region.fractions(run));
                window
                    .paint_image(
                        cell,
                        frame,
                        Corners::all(px(0.)),
                        0.,
                        result.clone(),
                        0,
                        false,
                    )
                    .ok();
            }
        }
    }

    /// `.cursor`: the brush outline following the pointer, dashed for the eraser.
    fn paint_cursor(&self, frame: Bounds<Pixels>, window: &mut Window) {
        let Some(at) = self.hover.filter(|at| self.painting && frame.contains(at)) else {
            return;
        };
        let diameter = px(self.brush);
        let ring = Bounds::new(
            point(at.x - diameter / 2., at.y - diameter / 2.),
            size(diameter, diameter),
        );
        let style = match self.tool {
            MaskTool::Brush => BorderStyle::Solid,
            MaskTool::Eraser => BorderStyle::Dashed,
        };
        window.paint_quad(
            PaintQuad::new(ring)
                .corner_radii(Corners::all(diameter / 2.))
                .border_widths(Edges::all(px(1.5))) // DS: MaskCanvas.module.css:68
                .border_color(self.ring)
                .border_style(style),
        );
    }
}

/// What the pointer handlers need.
pub(super) struct Input {
    pub(super) state: Entity<MaskCanvasState>,
    pub(super) frame: Bounds<Pixels>,
    pub(super) painting: bool,
    pub(super) tool: MaskTool,
    pub(super) brush: f32,
    pub(super) on_change: Option<ChangeHandler>,
}

/// `toPicture`: a window position in picture pixels.
fn to_picture(input: &Input, at: Point<Pixels>, picture: (u32, u32)) -> (f32, f32) {
    let rel = |from: Pixels, origin: Pixels, extent: Pixels, pixels: u32| {
        f32::from(from - origin) * pixels as f32 / f32::from(extent).max(1.)
    };
    (
        rel(
            at.x,
            input.frame.origin.x,
            input.frame.size.width,
            picture.0,
        ),
        rel(
            at.y,
            input.frame.origin.y,
            input.frame.size.height,
            picture.1,
        ),
    )
}

/// Pointer down paints, a move extends the stroke or moves the brush outline, up (or a release
/// outside the window) keeps the stroke and reports it.
pub(super) fn listen(input: Input, window: &mut Window) {
    let input = Rc::new(input);
    let down = input.clone();
    window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble
            || event.button != MouseButton::Left
            || !down.painting
            || !down.frame.contains(&event.position)
        {
            return;
        }
        down.state.update(cx, |state, cx| {
            let picture = state.size();
            let stroke = MaskStroke {
                tool: down.tool,
                size: down.brush * picture.0 as f32 / f32::from(down.frame.size.width).max(1.),
                points: vec![to_picture(&down, event.position, picture)],
            };
            state.begin(stroke, cx);
        });
        window.refresh();
    });
    let moved = input.clone();
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let drawing = moved.state.read(cx).drawing();
        if drawing && event.pressed_button != Some(MouseButton::Left) {
            end(&moved, window, cx);
            return;
        }
        moved.state.update(cx, |state, cx| {
            let inside = moved.painting && moved.frame.contains(&event.position);
            state.set_hover(inside.then_some(event.position), cx);
            if drawing {
                let picture = state.size();
                state.extend(to_picture(&moved, event.position, picture), cx);
            }
        });
        window.refresh();
    });
    window.on_mouse_event(move |_: &MouseUpEvent, _, window, cx| end(&input, window, cx));
}

fn end(input: &Input, window: &mut Window, cx: &mut App) {
    let report = input.state.update(cx, MaskCanvasState::finish);
    if let (Some((strokes, empty)), Some(on_change)) = (report, &input.on_change) {
        on_change(strokes, empty, window, cx);
    }
    window.refresh();
}
