//! The shell's UI. The app binary (`main.rs`) and the shot harness
//! (`bin/butler-shell-shots`) both build it from here.
pub(crate) mod assets;
pub(crate) mod chat;
pub(crate) mod composer;
pub(crate) mod decisions;
pub(crate) mod dialog;
pub(crate) mod exact_action;
pub(crate) mod field;
pub(crate) mod glass;
pub(crate) mod i18n;
pub(crate) mod inspector;
pub(crate) mod motion;
pub(crate) mod palette;
pub(crate) mod shell;
pub(crate) mod sidebar;
pub(crate) mod smooth_scroll;
pub(crate) mod source;
pub(crate) mod store;
pub(crate) mod theme;
pub(crate) mod viewer;
pub(crate) mod widgets;

pub(crate) use butler_ds::ui::Icon;

use std::borrow::Cow;

use gpui::{App, TextRenderingMode};

/// Loads the bundled faces and binds the keys.
pub(crate) fn init(cx: &mut App) -> anyhow::Result<()> {
    // Grayscale text everywhere: the window is translucent glass, and subpixel masks need an
    // opaque backdrop (owner decision 2026-10-29).
    cx.set_text_rendering_mode(TextRenderingMode::Grayscale);
    cx.text_system()
        .add_fonts(assets::FONTS.iter().map(|b| Cow::Borrowed(*b)).collect())?;
    butler_ds::ui::text::bind_keys(cx);
    cx.bind_keys(field::bindings());
    cx.bind_keys(composer::bindings());
    cx.bind_keys(shell::bindings());
    Ok(())
}
