//! A run of text at explicit type tokens, with the cap-height trim `Typo` applies. The new-chat
//! title, the ordinal and the moment override a role's size, weight or letter spacing, which
//! `Typo` does not take, so they are set here.
use gpui::{
    App, Div, FontWeight, IntoElement as _, ParentElement as _, SharedString, Styled as _, div, px,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::typo::Typo;

/// The type tokens of one run.
pub(super) struct Face {
    pub size: Length,
    pub line_height: Length,
    pub weight: f32,
    pub letter_spacing: f32,
}

/// `text` in `face`: a block whose glyphs sit with the capitals centred on the line.
pub(super) fn run(face: &Face, text: impl Into<SharedString>, ds: &Ds, cx: &App) -> Div {
    let text: SharedString = text.into();
    let size = f32::from(ds.len(face.size));
    let family = ds.body_font().clone();
    let offset = Typo::trim_offset(&family, size, cx, face.weight);
    let mut el = div()
        .text_size(px(size))
        .line_height(ds.len(face.line_height))
        .font_weight(FontWeight(face.weight))
        .font_family(family);
    if face.letter_spacing != 0. {
        el.text_style().letter_spacing = Some(px(face.letter_spacing));
    }
    el.child(
        div()
            .relative()
            .top(px(offset))
            .child(text)
            .into_any_element(),
    )
}
