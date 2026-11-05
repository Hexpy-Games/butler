//! The design-system context: one gpui `Global` the app updates on appearance, size and
//! setting changes. Components read it at render time and never keep their own copies.
use std::time::Duration;

use gpui::{App, BorrowAppContext as _, Global, Hsla, Pixels, SharedString};

use super::convert;
use crate::tokens::{
    Color, Density, Duration as DsDuration, FontStack, Length, Number, TokenContext,
};

/// The mobile type and sizing ramp applies at or below this viewport width (`width <= 640px`).
const COMPACT_MAX_WIDTH: f32 = 640.;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Platform {
    #[default]
    Mac,
    Windows,
    Linux,
}

/// How the last input arrived. The focus ring shows on keyboard focus only (text fields excepted).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Modality {
    Keyboard,
    #[default]
    Pointer,
}

/// The UI language. Korean text keeps words together (`:lang(ko)`: `word-break: keep-all`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lang {
    #[default]
    En,
    Ko,
}

/// Token context plus the app-level inputs that are not tokens.
pub struct Ds {
    tokens: TokenContext,
    platform: Platform,
    modality: Modality,
    os_reduced_motion: bool,
    app_reduced_motion: bool,
    lang: Lang,
    body_font: SharedString,
    code_font: SharedString,
}

impl Global for Ds {}

impl Ds {
    pub fn new(tokens: TokenContext, platform: Platform) -> Self {
        let body_font = SharedString::from(tokens.font(FontStack::FontBody)[0]);
        let code_font = SharedString::from(tokens.font(FontStack::FontFamilyCode)[0]);
        Self {
            tokens,
            platform,
            modality: Modality::default(),
            os_reduced_motion: false,
            app_reduced_motion: false,
            lang: Lang::default(),
            body_font,
            code_font,
        }
    }

    /// Resolves `--font-body` and `--font-family-code` to the first installed family of each
    /// stack (the code stack ends at the body face, which carries the Hangul).
    pub fn detect_fonts(&mut self, installed: &[String]) {
        let first = |stack: FontStack| {
            self.tokens
                .font(stack)
                .iter()
                .find(|family| installed.iter().any(|name| name == *family))
                .map(|family| SharedString::from(*family))
        };
        let body = first(FontStack::FontBody);
        let code = first(FontStack::FontFamilyCode);
        if let Some(body) = body {
            self.body_font = body;
        }
        self.code_font = code.unwrap_or_else(|| self.body_font.clone());
    }

    pub fn install(self, cx: &mut App) {
        cx.set_global(self);
    }

    pub fn get(cx: &App) -> &Self {
        cx.global::<Self>()
    }

    /// Mutates the global; the caller refreshes its windows.
    pub fn update(cx: &mut App, change: impl FnOnce(&mut Self)) {
        cx.update_global::<Self, _>(|ds, _| change(ds));
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

    pub fn code_font(&self) -> &SharedString {
        &self.code_font
    }

    pub fn dark(&self) -> bool {
        self.tokens.dark
    }

    pub fn reduced_motion(&self) -> bool {
        self.tokens.reduced_motion
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

    pub fn set_app_reduced_motion(&mut self, on: bool) {
        self.app_reduced_motion = on;
        self.tokens.reduced_motion = on || self.os_reduced_motion;
    }

    pub fn color(&self, token: Color) -> Hsla {
        convert::hsla(self.tokens.color(token))
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
