//! A scroll body that fills its frame, as the web DS's scrollers do (`height: 100%`, or `flex: 1 1 auto; min-height: 0` in a flex column).
use gpui::{Div, InteractiveElement, Styled, div};

/// The scroll body: fills the frame and shrinks to it, so it scrolls instead of growing.
pub fn body(content: Div, slot: &'static str) -> Div {
    content
        .flex_auto()
        .min_h_0()
        .debug_selector(move || format!("slot:{slot}"))
}

/// The frame around a scroll body: a flex column the body fills.
pub fn frame(slot: &'static str) -> Div {
    div()
        .flex()
        .flex_col()
        .min_h_0()
        .debug_selector(move || format!("slot:{slot}:frame"))
}
