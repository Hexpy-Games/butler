//! The App window: opening it (at startup, from the tray, on a dock reopen) and what closing
//! the last one does (main.mjs:2067-2074, 2767-2770). Electron hides the window; gpui drops it
//! and the next [`open_window`] builds a new shell that re-attaches and reloads from the Agent.
use std::ffi::OsString;

use gpui::{
    App, AppContext as _, Bounds, TitlebarOptions, WindowBackgroundAppearance, WindowBounds,
    WindowOptions, px, size,
};

use crate::ui::i18n::Locale;
use crate::ui::shell::{Shell, ShellOptions};
use crate::ui::theme::Platform;

/// Opens a window on the data folder and applies the navigation `args` carry
/// (`--butler-new-chat`, `--butler-open-session=<id>`, `butler://…`).
pub(crate) fn open_window(cx: &mut App, args: &[OsString]) -> anyhow::Result<()> {
    let locale = Locale::from_tag(&sys_locale::get_locale().unwrap_or_default());
    let bounds = Bounds::centered(None, size(px(960.), px(710.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some(locale.strings().app_title.into()),
            appears_transparent: true,
            traffic_light_position: None,
        }),
        window_min_size: Some(size(px(320.), px(480.))),
        app_id: Some("butler-shell".into()),
        ..Default::default()
    };
    let code_font = crate::ui::theme::code_font(&cx.text_system().all_font_names());
    let data = super::runtime(cx).map(|runtime| runtime.read(cx).data.clone());
    let attachment = crate::ui::source::agent::Attachment::start(data);
    let window = cx.open_window(options, move |window, cx| {
        // Butler's Electron window uses the acrylic material; where the platform has none the
        // shell paints an opaque fallback.
        window.set_background_appearance(WindowBackgroundAppearance::Acrylic);
        let options = ShellOptions {
            source: None,
            dark: None,
            code_font,
            locale,
            platform: Platform::host(),
        };
        cx.new(|cx| {
            let mut shell = Shell::new(options, window, cx);
            shell.attach(attachment, cx);
            shell
        })
    })?;
    let navigation = crate::ui::shell::navigation::Navigation::from_args(
        &args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    );
    window.update(cx, |view, window, cx| {
        if let Some(request) = navigation {
            view.navigate(request, window, cx);
        }
        window.focus(&view.focus_handle(), cx);
        cx.activate(true);
    })?;
    Ok(())
}

/// The tray's Open and the dock's reopen: a new window when none is open, else bring the App
/// forward.
pub(crate) fn reopen(cx: &mut App) {
    if !cx.windows().is_empty() {
        cx.activate(true);
        return;
    }
    if let Err(error) = open_window(cx, &[]) {
        eprintln!("butler-shell: {error:#}");
    }
}

/// The last window closed: quit on Windows, or when the tray is off or failed to start;
/// otherwise the App keeps running with the tray and the Agent.
pub(super) fn closed(cx: &mut App) {
    if !cx.windows().is_empty() {
        return;
    }
    if matches!(Platform::host(), Platform::Windows) || !super::tray::active(cx) {
        super::quit(cx);
    }
}
