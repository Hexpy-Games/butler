//! Measuring a box: container queries and `ResizeObserver` read a box's own size, which gpui
//! knows only after layout. [`track`] returns the size the box had on the last frame and a
//! recorder to place inside the box (absolutely, filling it); a change asks for another frame.
use gpui::{
    AnyElement, App, Bounds, ElementId, FontWeight, IntoElement as _, Pixels, SharedString, Size,
    Styled as _, TextRun, Window, canvas, font, px,
};

use crate::tokens::{Length, Number};
use crate::ui::context::Ds;

/// How much a size may drift before it counts as changed.
const EPSILON: f32 = 0.5;

/// The last measured size of the box `id` (zero before the first frame) and its recorder.
pub fn track(
    id: impl Into<ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> (Size<Pixels>, AnyElement) {
    let id = id.into();
    let state = window.use_keyed_state((id, "measure"), cx, |_, _| Size::<Pixels>::default());
    let seen = *state.read(cx);
    let recorder = canvas(
        |bounds: Bounds<Pixels>, _, _| bounds.size,
        move |_, size, window, cx| {
            let now = *state.read(cx);
            let moved = (now.width - size.width).abs() > px(EPSILON)
                || (now.height - size.height).abs() > px(EPSILON);
            if moved {
                state.update(cx, |state, _| *state = size);
                window.request_animation_frame();
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element();
    (seen, recorder)
}

/// How many lines `text` takes wrapped to `width` at `size` in the regular body face.
pub fn wrapped_lines(text: &str, size: Length, width: f32, window: &mut Window, cx: &App) -> usize {
    let ds = Ds::get(cx);
    let mut face = font(ds.body_font().clone());
    face.weight = FontWeight(ds.number(Number::FontWeightRegular));
    let run = TextRun {
        len: text.len(),
        font: face,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
        letter_spacing: None,
    };
    window
        .text_system()
        .shape_text(
            SharedString::from(text.to_owned()),
            ds.len(size),
            &[run],
            Some(px(width)),
            None,
        )
        .map_or(0, |shaped| shaped.line_count())
}

/// The width of one line of `text` at `size` in the regular body face (tabular figures).
pub fn text_width(text: &str, size: Length, window: &mut Window, cx: &App) -> f32 {
    let ds = Ds::get(cx);
    let mut face = font(ds.body_font().clone());
    face.weight = FontWeight(ds.number(Number::FontWeightRegular));
    face.features = gpui::FontFeatures(std::sync::Arc::new(vec![("tnum".to_owned(), 1)]));
    let run = TextRun {
        len: text.len(),
        font: face,
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
        letter_spacing: None,
    };
    let line =
        window
            .text_system()
            .shape_line(SharedString::from(text.to_owned()), ds.len(size), &[run]);
    f32::from(line.width)
}
