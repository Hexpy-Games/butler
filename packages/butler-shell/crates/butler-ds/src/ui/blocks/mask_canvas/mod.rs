//! DS MaskCanvas (MaskCanvas.tsx / MaskCanvas.module.css / maskStrokes.ts): a picture with a
//! paint layer for marking the region an edit may change. The brush paints, the eraser removes,
//! `undo` steps back, `clear` empties the layer, and `to_mask_png` gives the edit mask at the
//! picture's own pixels. The frame keeps the picture's shape inside the space it is given.
//!
//! Strokes are kept in picture pixels in a [`MaskCanvasState`] entity (the product keeps the
//! entity and calls its methods; it is the React `MaskCanvasHandle`). Painting is input-driven:
//! pointer events draw into a reduced paint layer and the layer is shown at 45% opacity in the
//! theme's accent. Nothing here runs a frame loop.
//!
//! The painted region's wash (generating) and the edited picture (result) are clipped to the
//! cells of the layer that hold paint, in 4 px steps.
mod paint;
mod raster;
mod state;

use std::rc::Rc;

use gpui::{
    App, CursorStyle, ElementId, ImageSource, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, Styled as _, Window, canvas, div,
};

use self::paint::{Frame, Input, fit, listen};
pub use self::state::MaskCanvasState;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::media_frame::{Load, resolve};

type ChangeHandler = Rc<dyn Fn(usize, bool, &mut Window, &mut App)>;
type ShownHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// The brush paints; the eraser removes paint.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MaskTool {
    #[default]
    Brush,
    Eraser,
}

/// One brush or eraser stroke in the picture's own pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct MaskStroke {
    pub tool: MaskTool,
    /// Diameter in picture pixels.
    pub size: f32,
    pub points: Vec<(f32, f32)>,
}

#[derive(IntoElement)]
pub struct MaskCanvas {
    id: ElementId,
    state: gpui::Entity<MaskCanvasState>,
    src: ImageSource,
    alt: SharedString,
    tool: MaskTool,
    brush_size: f32,
    disabled: bool,
    compare_src: Option<ImageSource>,
    generating: bool,
    result_src: Option<ImageSource>,
    on_change: Option<ChangeHandler>,
    on_result_shown: Option<ShownHandler>,
}

impl MaskCanvas {
    /// `state` holds the strokes; `src` is the picture, `alt` names it for assistive tech.
    pub fn new(
        id: impl Into<ElementId>,
        state: gpui::Entity<MaskCanvasState>,
        src: impl Into<ImageSource>,
        alt: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            state,
            src: src.into(),
            alt: alt.into(),
            tool: MaskTool::Brush,
            brush_size: 32.,
            disabled: false,
            compare_src: None,
            generating: false,
            result_src: None,
            on_change: None,
            on_result_shown: None,
        }
    }

    pub fn tool(mut self, tool: MaskTool) -> Self {
        self.tool = tool;
        self
    }

    /// Brush diameter in screen pixels, whatever the picture's zoom.
    pub fn brush_size(mut self, size: f32) -> Self {
        self.brush_size = size;
        self
    }

    /// Painting is off (sending, comparing).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Shows this picture in place of `src` and hides the mask while set (press-and-hold compare).
    pub fn compare_src(mut self, src: Option<ImageSource>) -> Self {
        self.compare_src = src;
        self
    }

    /// The painted region is washed while the edit runs.
    pub fn generating(mut self, generating: bool) -> Self {
        self.generating = generating;
        self
    }

    /// A new picture shown inside the painted region only.
    pub fn result_src(mut self, src: Option<ImageSource>) -> Self {
        self.result_src = src;
        self
    }

    /// A stroke ended: the stroke count and whether the mask is empty. `undo` and `clear` go
    /// through the state, whose `strokes()` and `empty()` the caller reads after them.
    pub fn on_change(
        mut self,
        handler: impl Fn(usize, bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// The result is on screen (once per result picture).
    pub fn on_result_shown(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_result_shown = Some(Rc::new(handler));
        self
    }

    /// The picture's name for assistive tech (gpui has no accessible-name slot on a canvas yet).
    pub fn alt(&self) -> &SharedString {
        &self.alt
    }
}

/// The decoded picture behind `source`, once it has loaded.
fn load(
    id: &ElementId,
    part: &'static str,
    source: &ImageSource,
    window: &mut Window,
    cx: &mut App,
) -> Option<std::sync::Arc<gpui::RenderImage>> {
    match resolve(&(id.clone(), part).into(), source, window, cx) {
        Load::Ready(data) => Some(data),
        Load::Pending | Load::Failed => None,
    }
}

/// The paint layer as an image. A new layer is decoded once and the one before it released.
fn layer_image(
    state: &gpui::Entity<MaskCanvasState>,
    id: &ElementId,
    window: &mut Window,
    cx: &mut App,
) -> Option<std::sync::Arc<gpui::RenderImage>> {
    let (version, png) = state.update(cx, |state, _| state.wash())?;
    let slot = window.use_keyed_state((id.clone(), "layer"), cx, |_, _| {
        None::<(u64, std::sync::Arc<gpui::RenderImage>)>
    });
    if let Some((seen, data)) = slot.read(cx)
        && *seen == version
    {
        return Some(data.clone());
    }
    let data = png.to_image_data(cx.svg_renderer()).ok()?;
    let old = slot.update(cx, |slot, _| slot.replace((version, data.clone())));
    if let Some((_, old)) = old {
        window.drop_image(old).ok();
    }
    Some(data)
}

/// The theme's paint colour as RGBA bytes.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a colour channel in 0..=1 scaled to a byte"
)]
fn rgba(color: gpui::Hsla) -> [u8; 4] {
    let color = gpui::hsla_to_rgba(color);
    [color.red, color.green, color.blue, color.alpha]
        .map(|channel| (channel.clamp(0., 1.) * 255.).round() as u8)
}

impl RenderOnce for MaskCanvas {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (accent, ring, radius) = (
            ds.color(Color::Accent),
            ds.color(Color::NeutralWhite),
            ds.len(Length::RadiusControl),
        );
        let comparing = self.compare_src.is_some();
        let painting = !self.disabled && !comparing && !self.generating;
        self.state
            .update(cx, |state, _| state.set_paint(rgba(accent)));

        let shown = self.compare_src.as_ref().unwrap_or(&self.src);
        let part = if comparing { "compare" } else { "picture" };
        let picture = load(&self.id, part, shown, window, cx);
        let layer = if comparing {
            None
        } else {
            layer_image(&self.state, &self.id, window, cx)
        };
        let region = (self.generating || self.result_src.is_some())
            .then(|| self.state.update(cx, |state, _| state.coverage()))
            .flatten();
        let result = self
            .result_src
            .as_ref()
            .and_then(|src| load(&self.id, "result", src, window, cx))
            .zip(region.clone());
        if let Some((data, _)) = &result {
            self.announce_result(data.id.0 as u64 + 1, window, cx);
        }
        let frame = Frame {
            picture,
            layer,
            wash: if self.generating { region } else { None },
            result,
            radius,
            accent,
            ring,
            tool: self.tool,
            brush: self.brush_size,
            hover: self.state.read(cx).hover(),
            painting,
        };
        let (state, tool, brush, on_change) = (
            self.state.clone(),
            self.tool,
            self.brush_size,
            self.on_change,
        );
        let mut root = div().id(self.id).size_full().min_w_0().min_h_0();
        if painting {
            root = root.cursor(CursorStyle::Crosshair);
        }
        root.child(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, cx| {
                    let (width, height) = state.read(cx).size();
                    let area = fit(bounds, width, height);
                    frame.paint(area, window);
                    listen(
                        Input {
                            state: state.clone(),
                            frame: area,
                            painting,
                            tool,
                            brush,
                            on_change: on_change.clone(),
                        },
                        window,
                    );
                },
            )
            .size_full(),
        )
    }
}

impl MaskCanvas {
    /// `onResultShown`: once per result picture, when it is first drawn.
    fn announce_result(&self, result_id: u64, window: &mut Window, cx: &mut App) {
        let Some(handler) = self.on_result_shown.clone() else {
            return;
        };
        let seen = window.use_keyed_state((self.id.clone(), "result-shown"), cx, |_, _| 0_u64);
        if *seen.read(cx) != result_id {
            seen.update(cx, |seen, _| *seen = result_id);
            window.defer(cx, move |window, cx| handler(window, cx));
        }
    }
}
