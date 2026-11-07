//! Butler DS tokens (packages/butler-app/client/ui/src/libs/design-system/tokens.css), light
//! (`:root`/.theme-light) and dark (.theme-dark), over the native window material.
use butler_ds::tokens::{Color, FontStack, TokenContext};
use butler_ds::ui::convert;
use gpui::Hsla;

use crate::ui::i18n::Strings;

pub(crate) fn alpha(c: Hsla, a: f32) -> Hsla {
    Hsla {
        alpha: c.alpha * a,
        ..c
    }
}

/// --font-body: the bundled static Pretendard family in the CSS stack.
pub(crate) const FONT_BODY: &str = TokenContext::DEFAULT.font(FontStack::FontBody)[1];

/// --font-family-code: the first installed family with the rest of the stack as per-glyph
/// fallbacks, ending at the body face (`butler_ds::ui::fonts`).
pub(crate) fn code_font(installed: &[String]) -> gpui::Font {
    butler_ds::ui::fonts::code_font(&TokenContext::DEFAULT, installed, FONT_BODY)
}

#[derive(Clone, Copy)]
pub(crate) enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub(crate) fn host() -> Self {
        match butler_platform::launcher::node_platform() {
            "darwin" => Self::Mac,
            "win32" => Self::Windows,
            _ => Self::Linux,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Theme {
    pub(crate) dark: bool,
    pub(crate) platform: Platform,
    pub(crate) code_font: gpui::Font,
    /// The UI copy in the OS's language.
    pub(crate) strings: &'static Strings,
    /// --text-primary.
    pub(crate) text: Hsla,
    /// --placeholder.
    pub(crate) placeholder: Hsla,
    /// --accent.
    pub(crate) accent: Hsla,
}

fn color(context: &TokenContext, token: Color) -> Hsla {
    convert::hsla(context.color(token))
}

impl Theme {
    pub(crate) fn new(
        dark: bool,
        platform: Platform,
        code_font: gpui::Font,
        strings: &'static Strings,
    ) -> Self {
        let context = TokenContext {
            dark,
            ..TokenContext::DEFAULT
        };
        let c = |token| color(&context, token);
        Self {
            dark,
            platform,
            code_font,
            strings,
            text: c(Color::TextPrimary),
            placeholder: c(Color::Placeholder),
            accent: c(Color::Accent),
        }
    }
}
