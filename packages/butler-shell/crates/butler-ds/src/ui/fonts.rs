//! The code font (`--font-family-code`) as gpui resolves a CSS font stack: the first installed
//! family draws, and the remaining installed families of the stack are per-glyph fallbacks, so
//! Latin stays IBM Plex Mono while Hangul takes IBM Plex Sans KR, as in Electron.
use gpui::{Font, FontFallbacks, SharedString, font};

use crate::tokens::{FontStack, TokenContext};

/// `--font-family-code` among `installed`: the first installed family with the rest as
/// fallbacks, ending at `body` (the bundled body face) for anything the stack does not cover.
pub fn code_font(tokens: &TokenContext, installed: &[String], body: &str) -> Font {
    let mut families: Vec<String> = tokens
        .font(FontStack::FontFamilyCode)
        .iter()
        .filter(|family| installed.iter().any(|name| name == *family))
        .map(|family| (*family).to_owned())
        .collect();
    if !families.iter().any(|family| family == body) {
        families.push(body.to_owned());
    }
    let family = SharedString::from(families.remove(0));
    let mut code = font(family);
    if !families.is_empty() {
        code.fallbacks = Some(FontFallbacks::from_fonts(families));
    }
    code
}
