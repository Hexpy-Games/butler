//! Butler DS tokens (packages/butler-app/client/ui/src/libs/design-system/tokens.css), light
//! (`:root`/.theme-light) and dark (.theme-dark), over the native window material.
use gpui::{BoxShadow, Hsla, Rgba, SharedString, point, px};

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

/// `top` composited over an opaque `bottom`.
pub(crate) fn over(top: Hsla, bottom: Hsla) -> Hsla {
    let (t, b) = (gpui::hsla_to_rgba(top), gpui::hsla_to_rgba(bottom));
    let m = |x: f32, y: f32| x * t.alpha + y * (1. - t.alpha);
    gpui::rgb_to_hsla(Rgba::new(
        m(t.red, b.red),
        m(t.green, b.green),
        m(t.blue, b.blue),
        1.,
    ))
}

/// Pretendard is bundled (OFL). Code uses the first installed family of Butler's
/// `--font-family-code` stack ([`code_font`]).
pub(crate) const FONT_BODY: &str = "Pretendard";

/// Butler's code font stack, in order; the body font when none is installed.
const CODE_FONTS: [&str; 6] = [
    "IBM Plex Mono",
    "SF Mono",
    "Menlo",
    "Consolas",
    "DejaVu Sans Mono",
    "Liberation Mono",
];

/// The first family of [`CODE_FONTS`] among `installed`.
pub(crate) fn code_font(installed: &[String]) -> SharedString {
    CODE_FONTS
        .iter()
        .find(|family| installed.iter().any(|name| name == *family))
        .map_or(FONT_BODY, |family| *family)
        .into()
}

/// Butler type roles (px size, px line height).
pub(crate) mod typo {
    pub(crate) const BODY: (f32, f32) = (14., 20.);
    pub(crate) const DOC: (f32, f32) = (14., 22.);
    pub(crate) const LABEL: (f32, f32) = (13., 18.);
    pub(crate) const CAPTION: (f32, f32) = (12., 16.);
    pub(crate) const APP_TITLE: (f32, f32) = (15., 20.);
}

#[derive(Clone)]
pub(crate) struct Theme {
    pub(crate) dark: bool,
    pub(crate) code_font: SharedString,
    pub(crate) text: Hsla,
    pub(crate) text2: Hsla,
    pub(crate) text3: Hsla,
    pub(crate) placeholder: Hsla,
    /// --windows-sidebar-bg: the shell over the native acrylic.
    pub(crate) shell: Hsla,
    /// Tint under the shell when the native acrylic is unavailable (approximates it).
    pub(crate) acrylic_fallback: Hsla,
    /// --shell-card-edge.
    pub(crate) card_edge: Hsla,
    pub(crate) paper: Hsla,
    pub(crate) selection: Hsla,
    pub(crate) selection_strong: Hsla,
    /// SidebarShell overrides: hover = selection 60%, active = selection 75%.
    pub(crate) nav_hover: Hsla,
    pub(crate) nav_active: Hsla,
    pub(crate) line: Hsla,
    pub(crate) line_strong: Hsla,
    pub(crate) surface: Hsla,
    pub(crate) surface_raised: Hsla,
    pub(crate) user_bubble: Hsla,
    pub(crate) glass_divider: Hsla,
    pub(crate) glass_shadow: BoxShadow,
    pub(crate) send_bg: Hsla,
    pub(crate) send_fg: Hsla,
    pub(crate) send_disabled: Hsla,
    pub(crate) accent: Hsla,
    pub(crate) accent_text: Hsla,
    pub(crate) secondary_bg: Hsla,
    pub(crate) secondary_border: Hsla,
    pub(crate) tool_chip: Hsla,
    pub(crate) syntax: Syntax,
}

/// Code block highlight colours.
#[derive(Clone, Copy)]
pub(crate) struct Syntax {
    pub(crate) keyword: Hsla,
    pub(crate) string: Hsla,
    pub(crate) comment: Hsla,
    pub(crate) number: Hsla,
    pub(crate) title: Hsla,
}

fn shadow(y: f32, blur: f32, color: Hsla) -> BoxShadow {
    BoxShadow {
        color: color.into(),
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    }
}

impl Theme {
    pub(crate) fn new(dark: bool, code_font: SharedString) -> Self {
        if dark {
            Self::dark(code_font)
        } else {
            Self::light(code_font)
        }
    }

    fn light(code_font: SharedString) -> Self {
        let text = hex(0x0022_2326);
        Self {
            dark: false,
            code_font,
            text,
            text2: hex(0x0069_6d73),
            text3: hex(0x006d_7279),
            placeholder: hex(0x006a_6e74),
            shell: rgba(255, 255, 255, 0.36),
            acrylic_fallback: rgba(238, 240, 243, 1.),
            card_edge: alpha(text, 0.08),
            paper: rgba(250, 250, 248, 1.),
            selection: rgba(32, 35, 39, 0.07),
            selection_strong: rgba(32, 35, 39, 0.10),
            nav_hover: rgba(32, 35, 39, 0.07 * 0.60),
            nav_active: rgba(32, 35, 39, 0.07 * 0.75),
            line: hex(0x00e9_eaec),
            line_strong: hex(0x00d5_d7da),
            surface: rgba(255, 255, 255, 0.9),
            surface_raised: rgba(255, 255, 255, 0.96),
            user_bubble: rgba(244, 245, 247, 0.92),
            glass_divider: rgba(0, 0, 0, 0.045),
            glass_shadow: shadow(12., 28., rgba(0, 0, 0, 0.06)),
            send_bg: hex(0x0026_282c),
            send_fg: hex(0x00ff_ffff),
            send_disabled: hex(0x00d5_d7da),
            accent: hex(0x0000_7aff),
            accent_text: hex(0x0000_66d9),
            secondary_bg: rgba(32, 35, 39, 0.08),
            secondary_border: rgba(0, 0, 0, 0.),
            tool_chip: rgba(255, 255, 255, 0.9 * 0.74),
            syntax: Syntax {
                keyword: hex(0x0000_52b3),
                string: hex(0x001b_7733),
                comment: hex(0x0071_767d),
                number: hex(0x0099_6c00),
                title: hex(0x0000_66d9),
            },
        }
    }

    fn dark(code_font: SharedString) -> Self {
        let text = hex(0x00f2_f3f4);
        Self {
            dark: true,
            code_font,
            text,
            text2: hex(0x00b5_b8bd),
            text3: hex(0x008b_8f97),
            placeholder: hex(0x0096_9a9f),
            shell: rgba(24, 25, 28, 0.46),
            acrylic_fallback: rgba(32, 33, 36, 1.),
            card_edge: alpha(text, 0.06),
            paper: rgba(25, 28, 36, 1.),
            selection: rgba(255, 255, 255, 0.08),
            selection_strong: rgba(255, 255, 255, 0.13),
            nav_hover: rgba(255, 255, 255, 0.08 * 0.60),
            nav_active: rgba(255, 255, 255, 0.08 * 0.75),
            line: rgba(255, 255, 255, 0.10),
            line_strong: rgba(255, 255, 255, 0.16),
            surface: rgba(30, 31, 34, 0.9),
            surface_raised: rgba(35, 36, 39, 0.96),
            user_bubble: rgba(255, 255, 255, 0.10),
            glass_divider: rgba(255, 255, 255, 0.055),
            glass_shadow: shadow(14., 34., rgba(0, 0, 0, 0.28)),
            send_bg: text,
            send_fg: hex(0x001f_2023),
            send_disabled: hex(0x005a_5d64),
            accent: hex(0x0000_7aff),
            accent_text: hex(0x004d_a6ff),
            secondary_bg: rgba(255, 255, 255, 0.08),
            secondary_border: rgba(255, 255, 255, 0.4),
            tool_chip: rgba(30, 31, 34, 0.9 * 0.74),
            syntax: Syntax {
                keyword: hex(0x0080_bfff),
                string: hex(0x0080_d494),
                comment: hex(0x009a_9da2),
                number: hex(0x00ff_d44d),
                title: hex(0x00b3_d9ff),
            },
        }
    }
}
