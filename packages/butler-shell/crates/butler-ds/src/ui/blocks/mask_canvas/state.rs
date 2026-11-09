//! The strokes of a MaskCanvas (the `strokes` and `active` refs of MaskCanvas.tsx, and its
//! imperative handle). The state is an entity: the canvas paints it and the product's toolbar
//! calls `undo`, `clear` and `to_mask_png` on it.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a layer side is a rounded, positive pixel count"
)]
use std::sync::Arc;

use gpui::{Context, Image, ImageFormat, Pixels, Point};
use tiny_skia::Pixmap;

use super::raster::{self, Coverage, LAYER_MAX};
use super::{MaskStroke, MaskTool};

pub struct MaskCanvasState {
    width: u32,
    height: u32,
    /// What a new picture starts with; `reset` returns to it.
    defaults: Vec<MaskStroke>,
    strokes: Vec<MaskStroke>,
    /// The stroke being drawn (pointer down, not yet up).
    active: Option<MaskStroke>,
    layer: Option<Pixmap>,
    scale: f32,
    /// The paint colour of the strokes (the theme's accent), as RGBA.
    paint: [u8; 4],
    /// Moves on every change of the layer.
    version: u64,
    blank: bool,
    wash: Option<(u64, Arc<Image>)>,
    coverage: Option<(u64, Arc<Coverage>)>,
    /// The pointer over the picture, for the brush outline.
    hover: Option<Point<Pixels>>,
}

impl MaskCanvasState {
    /// A mask for a `width` x `height` picture (its own pixels), starting with
    /// `default_strokes` (a mask kept for a retry); undo can remove them.
    pub fn new(width: u32, height: u32, default_strokes: Vec<MaskStroke>) -> Self {
        let mut state = Self {
            width,
            height,
            defaults: default_strokes.clone(),
            strokes: default_strokes,
            active: None,
            layer: None,
            scale: 1.,
            paint: [0, 0, 0, 255],
            version: 0,
            blank: true,
            wash: None,
            coverage: None,
            hover: None,
        };
        state.redraw();
        state
    }

    /// A new picture: its size, and the default strokes again.
    pub fn reset(&mut self, width: u32, height: u32, cx: &mut Context<Self>) {
        (self.width, self.height) = (width, height);
        self.strokes = self.defaults.clone();
        self.active = None;
        self.redraw();
        cx.notify();
    }

    /// Removes the last stroke.
    pub fn undo(&mut self, cx: &mut Context<Self>) {
        self.strokes.pop();
        self.redraw();
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.strokes.clear();
        self.redraw();
        cx.notify();
    }

    /// Strokes that undo can remove.
    pub fn strokes(&self) -> usize {
        self.strokes.len()
    }

    /// Nothing is painted (the eraser can empty a painted mask).
    pub fn empty(&self) -> bool {
        self.strokes.is_empty() || self.blank
    }

    /// PNG at the picture's size: transparent where painted (the edit region), opaque elsewhere;
    /// `None` when nothing is painted.
    pub fn to_mask_png(&self) -> Option<Vec<u8>> {
        if self.empty() {
            return None;
        }
        raster::mask_png(self.width, self.height, &self.strokes)
    }

    pub(super) fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub(super) fn hover(&self) -> Option<Point<Pixels>> {
        self.hover
    }

    pub(super) fn drawing(&self) -> bool {
        self.active.is_some()
    }

    pub(super) fn set_hover(&mut self, hover: Option<Point<Pixels>>, cx: &mut Context<Self>) {
        if self.hover != hover {
            self.hover = hover;
            cx.notify();
        }
    }

    /// The theme's paint colour; a new colour repaints the layer.
    pub(super) fn set_paint(&mut self, paint: [u8; 4]) {
        if self.paint != paint {
            self.paint = paint;
            self.redraw();
        }
    }

    /// Pointer down: the stroke starts with a dot.
    pub(super) fn begin(&mut self, stroke: MaskStroke, cx: &mut Context<Self>) {
        if let Some(layer) = self.layer.as_mut() {
            raster::draw(layer, self.scale, &stroke, 0, self.paint);
        }
        self.active = Some(stroke);
        self.blank = false;
        self.version += 1;
        cx.notify();
    }

    /// Pointer move: the stroke grows by a segment.
    pub(super) fn extend(&mut self, point: (f32, f32), cx: &mut Context<Self>) {
        let (Some(stroke), Some(layer)) = (self.active.as_mut(), self.layer.as_mut()) else {
            return;
        };
        stroke.points.push(point);
        raster::draw(
            layer,
            self.scale,
            stroke,
            stroke.points.len() - 1,
            self.paint,
        );
        self.version += 1;
        cx.notify();
    }

    /// Pointer up: the stroke is kept. Returns the stroke count and whether the mask is empty.
    pub(super) fn finish(&mut self, cx: &mut Context<Self>) -> Option<(usize, bool)> {
        let stroke = self.active.take()?;
        if let (MaskTool::Eraser, Some(layer)) = (stroke.tool, self.layer.as_ref()) {
            self.blank = raster::blank(layer);
        }
        self.strokes.push(stroke);
        cx.notify();
        Some((self.strokes(), self.empty()))
    }

    /// The paint layer as shown (PNG at 45% opacity); `None` while nothing is painted.
    pub(super) fn wash(&mut self) -> Option<(u64, Arc<Image>)> {
        if self.blank {
            return None;
        }
        if self
            .wash
            .as_ref()
            .is_none_or(|(seen, _)| *seen != self.version)
        {
            let bytes = raster::wash_png(self.layer.as_ref()?)?;
            self.wash = Some((
                self.version,
                Arc::new(Image::from_bytes(ImageFormat::Png, bytes)),
            ));
        }
        self.wash.clone()
    }

    /// The painted region, for the generating wash and the result.
    pub(super) fn coverage(&mut self) -> Option<Arc<Coverage>> {
        if self.blank {
            return None;
        }
        if self
            .coverage
            .as_ref()
            .is_none_or(|(seen, _)| *seen != self.version)
        {
            let covered = raster::coverage(self.layer.as_ref()?);
            self.coverage = Some((self.version, Arc::new(covered)));
        }
        self.coverage.as_ref().map(|(_, covered)| covered.clone())
    }

    /// `repaint`: the layer drawn again from every stroke.
    fn redraw(&mut self) {
        let longest = self.width.max(self.height).max(1) as f32;
        self.scale = (LAYER_MAX / longest).min(1.);
        let layer_side = |side: u32| ((side as f32 * self.scale).round() as u32).max(1);
        self.layer = Pixmap::new(layer_side(self.width), layer_side(self.height));
        if let Some(layer) = self.layer.as_mut() {
            for stroke in &self.strokes {
                raster::draw(layer, self.scale, stroke, 0, self.paint);
            }
            self.blank = raster::blank(layer);
        } else {
            self.blank = true;
        }
        self.version += 1;
    }
}
