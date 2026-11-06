//! The code font (`--font-family-code`) as gpui resolves a CSS font stack: the first installed
//! family draws, and the remaining installed families of the stack are per-glyph fallbacks, so
//! Latin stays IBM Plex Mono while Hangul takes IBM Plex Sans KR, as in Electron.
use gpui::{Font, FontFallbacks, SharedString, font};

use crate::tokens::{FontStack, TokenContext};

/// The DS change that adds "IBM Plex Sans KR" after "IBM Plex Mono" to `--font-family-code`
/// (owner choice 2026-11-06, branch `feat/code-font-plex-sans-kr`) has not reached the tokens
/// this crate is generated from. Until it does, the same stack is completed here; once the
/// generated stack contains the family this is a no-op and should be deleted.
const PENDING: (&str, &str) = ("IBM Plex Mono", "IBM Plex Sans KR");

fn code_stack(tokens: &TokenContext) -> Vec<&'static str> {
    let mut stack = tokens.font(FontStack::FontFamilyCode).to_vec();
    if !stack.contains(&PENDING.1)
        && let Some(at) = stack.iter().position(|family| *family == PENDING.0)
    {
        stack.insert(at + 1, PENDING.1);
    }
    stack
}

/// `--font-family-code` among `installed`: the first installed family with the rest as
/// fallbacks, ending at `body` (the bundled body face) for anything the stack does not cover.
pub fn code_font(tokens: &TokenContext, installed: &[String], body: &str) -> Font {
    let mut families: Vec<String> = code_stack(tokens)
        .into_iter()
        .filter(|family| installed.iter().any(|name| name == family))
        .map(str::to_owned)
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
