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

/// `text` in `face`: a block whose glyphs sit with the capitals centred on the line. A line
/// box never gets shorter than the font's ascent plus descent here, where CSS lets a tighter
/// `line-height` win; the block gives the excess back (a one-line block is then the line height)
/// and the glyphs move up by half of it, as CSS's half-leading puts them.
pub(super) fn run(face: &Face, text: impl Into<SharedString>, ds: &Ds, cx: &App) -> Div {
    let text: SharedString = text.into();
    let size = f32::from(ds.len(face.size));
    let line = f32::from(ds.len(face.line_height));
    let family = ds.body_font().clone();
    let (ascent, descent) = Typo::extent(&family, size, face.weight, cx);
    let excess = (ascent + descent - line).max(0.);
    let offset = Typo::trim_offset(&family, size, cx, face.weight) - excess / 2.;
    let mut el = div()
        .mb(px(-excess))
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
