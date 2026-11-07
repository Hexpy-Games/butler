//! Butler DS tokens (packages/butler-app/client/ui/src/libs/design-system/tokens.css), light
//! (`:root`/.theme-light) and dark (.theme-dark), over the native window material.
use butler_ds::tokens::{Color, FontStack, Length, Shadow, TokenContext};
use butler_ds::ui::convert;
use gpui::{BoxShadow, Hsla, Rgba};

use crate::ui::i18n::Strings;

pub(crate) fn rgba(red: u8, green: u8, blue: u8, opacity: f32) -> Hsla {
    let unit = |v: u8| f32::from(v) / 255.;
    gpui::rgb_to_hsla(Rgba::new(unit(red), unit(green), unit(blue), opacity))
}

pub(crate) fn hex(v: u32) -> Hsla {
    let c = |shift: u32| ((v >> shift) & 0xff) as f32 / 255.;
    gpui::rgb_to_hsla(Rgba::new(c(16), c(8), c(0), 1.))
}

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

/// Butler type roles (px size, px line height), from --typo-*.
pub(crate) mod typo {
    use super::{Length, TokenContext};
    const T: TokenContext = TokenContext::DEFAULT;
    pub(crate) const LABEL: (f32, f32) = (
        T.len(Length::TypoLabelSize),
        T.len(Length::TypoLabelLineHeight),
    );
    pub(crate) const CAPTION: (f32, f32) = (
        T.len(Length::TypoCaptionSize),
        T.len(Length::TypoCaptionLineHeight),
    );
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

    fn sidebar(self) -> (Color, Color, Color, Color, Color) {
        // AdaptiveShellCards.module.css:11 uses the platform-mapped sidebar-bg.
        match self {
            // AdaptiveShell.module.css:52: macOS material, row fills and sidebar text.
            Self::Mac => (
                Color::MacSidebarBg,
                Color::MacSidebarTextSecondary,
                Color::MacSidebarTextTertiary,
                Color::MacSidebarHoverBg,
                Color::MacSidebarSelectedBg,
            ),
            // AdaptiveShell.module.css:66: Windows material, row fills and sidebar text.
            Self::Windows => (
                Color::WindowsSidebarBg,
                Color::WindowsSidebarTextSecondary,
                Color::WindowsSidebarTextTertiary,
                Color::WindowsSidebarHoverBg,
                Color::WindowsSidebarSelectedBg,
            ),
            // AdaptiveShell.module.css:32: Linux keeps the base sidebar tokens.
            Self::Linux => (
                Color::SidebarBg,
                Color::SidebarTextSecondary,
                Color::SidebarTextTertiary,
                Color::SidebarHoverBg,
                Color::SidebarSelectedBg,
            ),
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
    /// --text-secondary (workspace).
    pub(crate) text2: Hsla,
    /// --sidebar-text-secondary, mapped by platform.
    pub(crate) sidebar_text2: Hsla,
    /// --text-tertiary (workspace).
    pub(crate) text3: Hsla,
    /// --sidebar-text-tertiary, mapped by platform.
    pub(crate) sidebar_text3: Hsla,
    /// --placeholder.
    pub(crate) placeholder: Hsla,
    /// --color-text-disabled: disabled controls change colour, not opacity.
    pub(crate) text_disabled: Hsla,
    /// --selection.
    pub(crate) selection: Hsla,
    /// --selection-strong.
    pub(crate) selection_strong: Hsla,
    /// Platform --sidebar-hover-bg, falling back to --selection at 60%.
    pub(crate) nav_hover: Hsla,
    /// Platform --sidebar-selected-bg, falling back to --selection at 75%.
    pub(crate) nav_active: Hsla,
    /// --line.
    pub(crate) line: Hsla,
    /// --line-strong.
    pub(crate) line_strong: Hsla,
    /// --surface.
    pub(crate) surface: Hsla,
    /// --surface-raised.
    pub(crate) surface_raised: Hsla,
    /// --accent.
    pub(crate) accent: Hsla,
    /// --secondary.
    pub(crate) secondary_bg: Hsla,
    /// --secondary-border.
    pub(crate) secondary_border: Hsla,
    /// --composer-glass-divider.
    pub(crate) glass_divider: Hsla,
    /// --composer-glass-shadow.
    pub(crate) glass_shadow: BoxShadow,
    /// --send-bg.
    pub(crate) send_bg: Hsla,
    /// --send-fg.
    pub(crate) send_fg: Hsla,
}

fn shadow(context: &TokenContext) -> BoxShadow {
    convert::box_shadows(context.shadow(Shadow::ComposerGlassShadow), context).remove(0)
}

fn color(context: &TokenContext, token: Color) -> Hsla {
    convert::hsla(context.color(token))
}

impl Theme {
    /// AdaptiveShell.module.css:120 and AdaptiveShellCards.module.css:89:
    /// inherited text aliases also reach shared controls in the shell scope.
    pub(crate) fn sidebar_scope(&self) -> Self {
        Self {
            text2: self.sidebar_text2,
            text3: self.sidebar_text3,
            ..self.clone()
        }
    }

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
        let (_, secondary, tertiary, hover, selected) = platform.sidebar();
        let selection = c(Color::Selection);
        // AdaptiveShell.module.css:116-131: sidebar text aliases and optional row fills.
        let row_fill = |token, fallback| context.try_color(token).map_or(fallback, |_| c(token));
        Self {
            dark,
            platform,
            code_font,
            strings,
            text: c(Color::TextPrimary),
            text2: c(Color::TextSecondary),
            text3: c(Color::TextTertiary),
            sidebar_text2: c(secondary),
            sidebar_text3: c(tertiary),
            placeholder: c(Color::Placeholder),
            text_disabled: c(Color::ColorTextDisabled),
            selection,
            selection_strong: c(Color::SelectionStrong),
            nav_hover: row_fill(hover, alpha(selection, 0.60)),
            nav_active: row_fill(selected, alpha(selection, 0.75)),
            line: c(Color::Line),
            line_strong: c(Color::LineStrong),
            surface: c(Color::Surface),
            surface_raised: c(Color::SurfaceRaised),
            accent: c(Color::Accent),
            secondary_bg: c(Color::Secondary),
            secondary_border: c(Color::SecondaryBorder),
            glass_divider: c(Color::ComposerGlassDivider),
            glass_shadow: shadow(&context),
            send_bg: c(Color::SendBg),
            send_fg: c(Color::SendFg),
        }
    }
}
