//! The design-system context: one gpui `Global` the app updates on appearance, size and
//! setting changes. Components read it at render time and never keep their own copies.
use std::time::Duration;

use gpui::{App, BorrowAppContext as _, Font, Global, Hsla, Pixels, SharedString, font};

use super::convert;
use crate::tokens::{
    Color, Density, Duration as DsDuration, FontStack, Length, Number, TokenContext,
};

/// The mobile type and sizing ramp applies at or below this viewport width (`width <= 640px`).
const COMPACT_MAX_WIDTH: f32 = 640.;

/// The row height inside a sheet. // DS: BottomSheet.module.css:29
pub const SHEET_ROW_HEIGHT: f32 = 44.;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Platform {
    #[default]
    Mac,
    Windows,
    Linux,
}

/// How the last input arrived. The focus ring shows on keyboard focus only (text fields
/// excepted), and on focus moved by the app before any input arrived (Chromium's
/// `:focus-visible` heuristic: a script's focus shows the ring unless a pointer press came last).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Modality {
    Keyboard,
    Pointer,
    /// No input yet.
    #[default]
    Initial,
}

impl Modality {
    /// Whether focus that arrives now matches `:focus-visible`.
    pub fn focus_visible(self) -> bool {
        self != Self::Pointer
    }
}

/// The UI language. Korean text keeps words together (`:lang(ko)`: `word-break: keep-all`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lang {
    #[default]
    En,
    Ko,
}

/// `word-break: keep-all; overflow-wrap: break-word`: Korean wraps between words, never inside one
/// (tokens.css `:lang(ko)`), and long unbroken tokens still wrap. Also the headings' own rule.
pub fn keep_words<E: gpui::Styled>(el: E) -> E {
    el.word_break(gpui::WordBreak::KeepAll)
        .overflow_wrap(gpui::OverflowWrap::BreakWord)
}

/// The OS "Reduce Transparency" and "Increase Contrast" settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DisplaySettings {
    reduce_transparency: bool,
    increase_contrast: bool,
}

/// Token context plus the app-level inputs that are not tokens.
pub struct Ds {
    tokens: TokenContext,
    platform: Platform,
    modality: Modality,
    os_reduced_motion: bool,
    app_reduced_motion: bool,
    /// The OS display settings Liquid Glass reads.
    display: DisplaySettings,
    lang: Lang,
    body_font: SharedString,
    code_font: Font,
    /// The on-screen keyboard's height (`--sheet-keyboard-inset`), fed in by the app.
    keyboard_inset: f32,
    /// Inside a sheet menus and lists have touch-sized rows (`--menu-item-height: 44px`).
    sheet_rows: bool,
    /// Tokens a subtree re-points to others (`--text-secondary: var(--sidebar-text-secondary)`
    /// on the shell's text): consulted by [`Self::color`], applied in order of nesting.
    remap: Vec<(Color, Color)>,
}

impl Global for Ds {}

impl Ds {
    pub fn new(tokens: TokenContext, platform: Platform) -> Self {
        let body_font = SharedString::from(tokens.font(FontStack::FontBody)[0]);
        let code_font = font(SharedString::from(
            tokens.font(FontStack::FontFamilyCode)[0],
        ));
        Self {
            tokens,
            platform,
            modality: Modality::default(),
            os_reduced_motion: false,
            app_reduced_motion: false,
            display: DisplaySettings::default(),
            lang: Lang::default(),
            body_font,
            code_font,
            keyboard_inset: 0.,
            sheet_rows: false,
            remap: Vec::new(),
        }
    }

    /// Resolves `--font-body` to its first installed family, and `--font-family-code` to its
    /// first installed family with the rest of the stack as per-glyph fallbacks (`fonts`).
    pub fn detect_fonts(&mut self, installed: &[String]) {
        let first = |stack: FontStack| {
            self.tokens
                .font(stack)
                .iter()
                .find(|family| installed.iter().any(|name| name == *family))
                .map(|family| SharedString::from(*family))
        };
        if let Some(body) = first(FontStack::FontBody) {
            self.body_font = body;
        }
        self.code_font = super::fonts::code_font(&self.tokens, installed, &self.body_font);
    }

    pub fn install(self, cx: &mut App) {
        cx.set_global(self);
        cx.set_global(gpui::WheelSmoothing(!cx.global::<Self>().reduced_motion()));
    }

    pub fn get(cx: &App) -> &Self {
        cx.global::<Self>()
    }

    /// Mutates the global; the caller refreshes its windows.
    pub fn update(cx: &mut App, change: impl FnOnce(&mut Self)) {
        cx.update_global::<Self, _>(|ds, _| change(ds));
        cx.set_global(gpui::WheelSmoothing(!cx.global::<Self>().reduced_motion()));
    }

    pub fn tokens(&self) -> &TokenContext {
        &self.tokens
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    pub fn modality(&self) -> Modality {
        self.modality
    }

    pub fn lang(&self) -> Lang {
        self.lang
    }

    pub fn body_font(&self) -> &SharedString {
        &self.body_font
    }

    pub fn code_font(&self) -> &Font {
        &self.code_font
    }

    pub fn dark(&self) -> bool {
        self.tokens.dark
    }

    pub fn reduced_motion(&self) -> bool {
        self.tokens.reduced_motion
    }

    pub fn reduced_transparency(&self) -> bool {
        self.display.reduce_transparency
    }

    pub fn increased_contrast(&self) -> bool {
        self.display.increase_contrast
    }

    pub fn compact(&self) -> bool {
        self.tokens.compact
    }

    pub fn set_lang(&mut self, lang: Lang) {
        self.lang = lang;
    }

    pub fn set_dark(&mut self, dark: bool) {
        self.tokens.dark = dark;
    }

    pub fn set_platform(&mut self, platform: Platform) {
        self.platform = platform;
    }

    pub fn set_density(&mut self, density: Density) {
        self.tokens.density = density;
    }

    pub fn set_ui_scale(&mut self, scale: f32) {
        self.tokens.ui_scale = scale;
    }

    /// The height the on-screen keyboard covers at the bottom of the window, in px. A platform
    /// that has one reports it here (the visual viewport's shortfall); desktop never does.
    pub fn set_keyboard_inset(&mut self, inset: f32) {
        self.keyboard_inset = inset.max(0.);
    }

    pub fn keyboard_inset(&self) -> f32 {
        self.keyboard_inset
    }

    /// Whether the rows being laid out are in a sheet.
    pub fn set_sheet_rows(&mut self, on: bool) {
        self.sheet_rows = on;
    }

    /// `--menu-item-height`: 44px inside a sheet (DS: BottomSheet.module.css:29).
    pub fn menu_item_height(&self) -> Pixels {
        if self.sheet_rows {
            gpui::px(SHEET_ROW_HEIGHT)
        } else {
            self.len(Length::MenuItemHeight)
        }
    }

    pub fn set_modality(&mut self, modality: Modality) {
        self.modality = modality;
    }

    /// The window's content size: it drives the mobile ramp and viewport-relative lengths.
    pub fn set_viewport(&mut self, width: f32, height: f32) {
        self.tokens.viewport = (width, height);
        self.tokens.compact = width <= COMPACT_MAX_WIDTH;
    }

    /// Reduced motion is the OS setting or the app setting.
    pub fn set_os_reduced_motion(&mut self, on: bool) {
        self.os_reduced_motion = on;
        self.tokens.reduced_motion = on || self.app_reduced_motion;
    }

    pub fn set_os_reduced_transparency(&mut self, on: bool) {
        self.display.reduce_transparency = on;
    }

    pub fn set_os_increased_contrast(&mut self, on: bool) {
        self.display.increase_contrast = on;
    }

    pub fn set_app_reduced_motion(&mut self, on: bool) {
        self.app_reduced_motion = on;
        self.tokens.reduced_motion = on || self.os_reduced_motion;
    }

    pub fn color(&self, token: Color) -> Hsla {
        convert::hsla(self.tokens.color(self.remapped(token)))
    }

    /// `token` as the subtree's re-pointings resolve it.
    pub fn resolve(&self, token: Color) -> Color {
        self.remapped(token)
    }

    /// The colour of `token` in the subtree, or `None` where the theme leaves it unset (CSS
    /// `initial`), so a `var(--x, fallback)` takes its fallback.
    pub fn try_color(&self, token: Color) -> Option<Hsla> {
        self.tokens
            .try_color(self.remapped(token))
            .map(convert::hsla)
    }

    /// Re-points colour tokens for a subtree and returns the mark to hand to [`Self::end_remap`].
    pub fn begin_remap(&mut self, pairs: &[(Color, Color)]) -> usize {
        let mark = self.remap.len();
        self.remap.extend_from_slice(pairs);
        mark
    }

    pub fn end_remap(&mut self, mark: usize) {
        self.remap.truncate(mark);
    }

    /// `token`, followed through the subtree's re-pointings (the latest wins; a chain such as
    /// text, then sidebar text, then the platform's sidebar text resolves in one go).
    fn remapped(&self, mut token: Color) -> Color {
        for _ in 0..4 {
            match self.remap.iter().rev().find(|(from, _)| *from == token) {
                Some((_, to)) if *to != token => token = *to,
                _ => break,
            }
        }
        token
    }

    pub fn density(&self) -> Density {
        self.tokens.density
    }

    pub fn len(&self, token: Length) -> Pixels {
        gpui::px(self.tokens.len(token))
    }

    pub fn number(&self, token: Number) -> f32 {
        self.tokens.number(token)
    }

    /// A duration token (milliseconds in the table).
    pub fn duration(&self, token: DsDuration) -> Duration {
        Duration::from_secs_f32(self.tokens.duration(token).max(0.) / 1000.)
    }
}
