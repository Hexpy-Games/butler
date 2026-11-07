//! Edge strokes (`TaskGraphCanvas.module.css` `.edge`, shared with the lanes): a 1.25px
//! `--line-strong` line, dashed while waiting, dashed `--danger` when broken, 2px
//! `--worker-active` into a running task. No motion.
use gpui::{Hsla, PathBuilder, Window, px};

use super::layout::EdgeState;
use crate::tokens::Color;
use crate::ui::context::Ds;

const WIDTH: f32 = 1.25; // DS: TaskGraphCanvas.module.css:55
const ACTIVE_WIDTH: f32 = 2.; // DS: TaskGraphCanvas.module.css:70
const DASH: [f32; 2] = [3., 4.]; // DS: TaskGraphCanvas.module.css:59

#[derive(Clone, Copy)]
pub(crate) struct EdgePalette {
    pub(crate) line: Hsla,
    danger: Hsla,
    active: Hsla,
}

impl EdgePalette {
    pub(crate) fn of(ds: &Ds) -> Self {
        Self {
            line: ds.color(Color::LineStrong),
            danger: ds.color(Color::Danger),
            active: ds.color(Color::WorkerActive),
        }
    }

    /// A path builder with the stroke of `state`, and its colour.
    pub(crate) fn stroke(&self, state: EdgeState) -> (PathBuilder, Hsla) {
        let dashed = |color| {
            let dash = DASH.map(px);
            (PathBuilder::stroke(px(WIDTH)).dash_array(&dash), color)
        };
        match state {
            EdgeState::Satisfied => (PathBuilder::stroke(px(WIDTH)), self.line),
            EdgeState::Waiting => dashed(self.line),
            EdgeState::Failed => dashed(self.danger),
            EdgeState::Active => (PathBuilder::stroke(px(ACTIVE_WIDTH)), self.active),
        }
    }
}

/// Paints a finished stroke.
pub(crate) fn paint(window: &mut Window, builder: PathBuilder, color: Hsla) {
    if let Ok(path) = builder.build() {
        window.paint_path(path, color);
    }
}
