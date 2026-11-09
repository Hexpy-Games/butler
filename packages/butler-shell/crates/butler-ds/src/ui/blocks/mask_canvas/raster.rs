//! MaskCanvas rasters (maskStrokes.ts): strokes drawn with tiny-skia. The paint layer the user
//! sees is a reduced copy (`LAYER_MAX` px on its longest side); the mask is drawn again at the
//! picture's own size from the strokes.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "pixel and colour conversions between f32 and integers stay in range"
)]
use tiny_skia::{
    BlendMode, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform,
};

use super::{MaskStroke, MaskTool};

/// Longest side of the paint layer that is shown.
pub(super) const LAYER_MAX: f32 = 512.;
/// `.layer { opacity: 0.45 }`, in percent.
const LAYER_OPACITY: u16 = 45; // DS: MaskCanvas.module.css:35
/// Cell size, in layer pixels, of the painted-region coverage.
const CELL: u32 = 4;

/// A row of covered cells: columns `from..to` of cell row `row`.
pub(super) struct Run {
    pub(super) row: u32,
    pub(super) from: u32,
    pub(super) to: u32,
}

/// The painted region, as runs of cells, over a layer of `width` x `height` px.
pub(super) struct Coverage {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) runs: Vec<Run>,
}

impl Coverage {
    /// A run as fractions of the picture: left, top, right, bottom.
    pub(super) fn fractions(&self, run: &Run) -> [f32; 4] {
        let across = |cell: u32| ((cell * CELL).min(self.width)) as f32 / self.width as f32;
        let down = |cell: u32| ((cell * CELL).min(self.height)) as f32 / self.height as f32;
        [
            across(run.from),
            down(run.row),
            across(run.to),
            down(run.row + 1),
        ]
    }
}

/// `drawSegment`: the dot of a stroke's first point, then its line from point `from - 1` on,
/// in picture pixels scaled by `scale`.
pub(super) fn draw(
    pixmap: &mut Pixmap,
    scale: f32,
    stroke: &MaskStroke,
    from: usize,
    rgba: [u8; 4],
) {
    let mut paint = Paint::default();
    paint.set_color_rgba8(rgba[0], rgba[1], rgba[2], rgba[3]);
    paint.anti_alias = true;
    paint.blend_mode = match stroke.tool {
        MaskTool::Brush => BlendMode::SourceOver,
        MaskTool::Eraser => BlendMode::DestinationOut,
    };
    let transform = Transform::from_scale(scale, scale);
    let points = &stroke.points;
    if let (true, Some(first)) = (points.len() == 1 || from == 0, points.first())
        && let Some(dot) = PathBuilder::from_circle(first.0, first.1, stroke.size / 2.)
    {
        pixmap.fill_path(&dot, &paint, FillRule::Winding, transform, None);
    }
    if points.len() > 1
        && let Some(start) = points.get(from.saturating_sub(1))
    {
        let mut path = PathBuilder::new();
        path.move_to(start.0, start.1);
        for point in points.iter().skip(from.max(1)) {
            path.line_to(point.0, point.1);
        }
        let line = Stroke {
            width: stroke.size,
            line_cap: LineCap::Round,
            line_join: LineJoin::Round,
            ..Stroke::default()
        };
        if let Some(path) = path.finish() {
            pixmap.stroke_path(&path, &paint, &line, transform, None);
        }
    }
}

/// `isBlank`: nothing is painted (every alpha is 0).
pub(super) fn blank(pixmap: &Pixmap) -> bool {
    pixmap
        .data()
        .as_chunks::<4>()
        .0
        .iter()
        .all(|pixel| pixel[3] == 0)
}

/// The layer as the user sees it: the paint at 45% opacity, as PNG.
pub(super) fn wash_png(pixmap: &Pixmap) -> Option<Vec<u8>> {
    let mut wash = pixmap.clone();
    for byte in wash.data_mut() {
        *byte = u8::try_from(u16::from(*byte) * LAYER_OPACITY / 100).unwrap_or(u8::MAX);
    }
    wash.encode_png().ok()
}

/// `maskBlob`: the edit mask at the picture's size, opaque black except the painted region,
/// which is transparent (alpha 0 = edit, soft at the brush edges). `None` when nothing is painted.
pub(super) fn mask_png(width: u32, height: u32, strokes: &[MaskStroke]) -> Option<Vec<u8>> {
    let mut pixmap = Pixmap::new(width, height)?;
    for stroke in strokes {
        draw(&mut pixmap, 1., stroke, 0, [0, 0, 0, 255]);
    }
    if blank(&pixmap) {
        return None;
    }
    for pixel in pixmap.data_mut().as_chunks_mut::<4>().0 {
        *pixel = [0, 0, 0, 255 - pixel[3]];
    }
    pixmap.encode_png().ok()
}

/// The cells of `pixmap` that hold any paint, row by row as runs.
pub(super) fn coverage(pixmap: &Pixmap) -> Coverage {
    let (width, height) = (pixmap.width(), pixmap.height());
    let cols = width.div_ceil(CELL);
    let data = pixmap.data();
    let covered = |col: u32, row: u32| {
        (row * CELL..((row + 1) * CELL).min(height)).any(|y| {
            (col * CELL..((col + 1) * CELL).min(width))
                .any(|x| data[((y * width + x) * 4 + 3) as usize] != 0)
        })
    };
    let mut runs = Vec::new();
    for row in 0..height.div_ceil(CELL) {
        let mut open: Option<u32> = None;
        for col in 0..=cols {
            match (col < cols && covered(col, row), open) {
                (true, None) => open = Some(col),
                (false, Some(from)) => {
                    runs.push(Run { row, from, to: col });
                    open = None;
                }
                _ => {}
            }
        }
    }
    Coverage {
        width,
        height,
        runs,
    }
}
