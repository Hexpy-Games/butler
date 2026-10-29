//! butler-shell (실험): Butler's experimental native desktop shell on gpui.
//!
//! The UI reads data only through [`source::Source`]; this build attaches none yet, so it
//! opens in the disconnected state.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod chat;
mod cliptop;
mod composer;
mod dialog;
mod glass;
mod input;
mod motion;
mod shell;
#[cfg(test)]
mod shots;
mod sidebar;
mod smooth_scroll;
mod source;
mod theme;
mod widgets;

use std::borrow::Cow;

use gpui::{
    App, AppContext as _, Bounds, TextRenderingMode, TitlebarOptions, WindowBackgroundAppearance,
    WindowBounds, WindowOptions, px, size,
};
use gpui_platform::application;

use shell::{Quit, Shell, ShellOptions};

/// Loads the bundled faces and binds the keys.
pub(crate) fn init(cx: &mut App) -> anyhow::Result<()> {
    // Grayscale text everywhere: the window is translucent glass, and subpixel masks need an
    // opaque backdrop (owner decision 2026-10-29).
    cx.set_text_rendering_mode(TextRenderingMode::Grayscale);
    cx.text_system()
        .add_fonts(assets::FONTS.iter().map(|b| Cow::Borrowed(*b)).collect())?;
    cx.bind_keys(input::bindings());
    cx.bind_keys(composer::bindings());
    cx.bind_keys(shell::bindings());
    Ok(())
}

fn open(cx: &mut App) -> anyhow::Result<()> {
    let bounds = Bounds::centered(None, size(px(960.), px(710.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("버틀러 (실험)".into()),
            appears_transparent: true,
            traffic_light_position: None,
        }),
        window_min_size: Some(size(px(320.), px(480.))),
        app_id: Some("butler-shell".into()),
        ..Default::default()
    };
    let code_font = theme::code_font(&cx.text_system().all_font_names());
    let window = cx.open_window(options, move |window, cx| {
        // Butler's Electron window uses the acrylic material; where the platform has none the
        // shell paints an opaque fallback.
        window.set_background_appearance(WindowBackgroundAppearance::Acrylic);
        let acrylic = window.background_appearance() == WindowBackgroundAppearance::Acrylic;
        let options = ShellOptions {
            source: None,
            acrylic,
            dark: None,
            code_font,
        };
        cx.new(|cx| Shell::new(options, window, cx))
    })?;
    window.update(cx, |view, window, cx| {
        window.focus(&view.focus_handle(), cx);
        cx.activate(true);
    })?;
    cx.on_window_closed(|cx, _| cx.quit()).detach();
    Ok(())
}

fn main() {
    application()
        .with_assets(assets::Assets)
        .run(|cx: &mut App| {
            cx.on_action(|_: &Quit, cx| cx.quit());
            if let Err(error) = init(cx).and_then(|()| open(cx)) {
                eprintln!("butler-shell: {error:#}");
                cx.quit();
            }
        });
}
