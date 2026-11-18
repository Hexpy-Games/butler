//! The App window: opening it (at startup, from the tray, on a dock reopen) and what closing
//! the last one does (main.mjs:2067-2074, 2767-2770). Electron hides the window; gpui drops it
//! and the next [`open_window`] builds a new shell that re-attaches and reloads from the Agent.
//! Windows stays in the tray too (Electron quits there, main.mjs:2076-2080): schedules use
//! the App's browser tabs while no window is open.
use std::ffi::OsString;

use gpui::{
    App, AppContext as _, Bounds, Pixels, Point, Size, TitlebarOptions, Window,
    WindowBackgroundAppearance, WindowBounds, WindowOptions, point, px, size,
};

/// The unscaled native metrics of a window: its traffic lights' top-left inset and minimum size.
pub(crate) struct WindowMetrics {
    pub buttons: (f32, f32),
    pub minimum: (f32, f32),
}

/// The App window: `macTrafficLightPosition` (Electron main.mjs:281), which centres the buttons on
/// the title row (gpui re-applies it on resize and on leaving fullscreen), and its minimum size
/// (main.mjs:2020-2021).
pub(crate) const MAIN: WindowMetrics = WindowMetrics {
    buttons: (20., 18.),
    minimum: (344., 480.),
};

/// `scaledWindowButtonPosition` (text-size.mjs): button centers follow the titlebar height;
/// native button diameter stays constant. Applied when the window opens and when the text size
/// changes.
pub(crate) fn scaled_traffic_lights(base: (f32, f32), scale: f32) -> Point<Pixels> {
    point(
        px((base.0 * scale).round()),
        px(((base.1 + 7.) * scale - 7.).round()),
    )
}

/// Minimum window size (text-size.mjs `updateWindow`).
pub(crate) fn min_size(base: (f32, f32), scale: f32, area: Option<Size<Pixels>>) -> Size<Pixels> {
    let minimum = size(px((base.0 * scale).ceil()), px((base.1 * scale).ceil()));
    match area {
        Some(area) => size(
            minimum.width.min(area.width),
            minimum.height.min(area.height),
        ),
        None => minimum,
    }
}

/// `updateWindow` (text-size.mjs): native window metrics follow the text scale.
pub(crate) fn apply_text_scale(window: &Window, metrics: &WindowMetrics, scale: f32, cx: &App) {
    window.set_traffic_light_position(scaled_traffic_lights(metrics.buttons, scale));
    window.set_window_min_size(min_size(
        metrics.minimum,
        scale,
        window
            .display(cx)
            .map(|display| display.visible_bounds().size),
    ));
}

/// `updateWindow` (text-size.mjs) `setZoomFactor`: every App window zooms its content by the text scale.
pub(crate) fn zoom_windows(scale: f32, cx: &mut App) {
    cx.defer(move |cx| {
        for window in cx.windows() {
            let _ = window.update(cx, |_, window, cx| window.set_zoom(scale, cx));
        }
    });
}

use crate::ui::i18n::Locale;
use crate::ui::shell::{Shell, ShellOptions};
use crate::ui::theme::Platform;

/// Opens a window on the data folder and applies the navigation `args` carry
/// (`--butler-new-chat`, `--butler-open-session=<id>`, `butler://…`).
pub(crate) fn open_window(cx: &mut App, args: &[OsString]) -> anyhow::Result<()> {
    let data = super::runtime(cx).map(|runtime| runtime.read(cx).data.clone());
    let saved = data
        .as_deref()
        .map(super::ui_state::read)
        .unwrap_or_default();
    let locale = saved
        .language
        .as_deref()
        .map(Locale::from_language)
        .unwrap_or_else(|| Locale::from_tag(&sys_locale::get_locale().unwrap_or_default()));
    let bounds = Bounds::centered(None, size(px(960.), px(710.)), cx);
    let scale = saved
        .text_size
        .as_deref()
        .and_then(crate::ui::shell::text_scale)
        .unwrap_or(1.);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some(locale.strings().app_title.into()),
            appears_transparent: true,
            traffic_light_position: Some(scaled_traffic_lights(MAIN.buttons, scale)),
        }),
        window_min_size: Some(min_size(MAIN.minimum, scale, None)),
        app_id: Some("butler-shell".into()),
        // AppKit neither drags a strip nor delays title-bar clicks; the bands move the window.
        app_owns_titlebar_drag: true,
        // A visible window animates at the display rate whether or not it has focus.
        inactive_frame_interval: None,
        ..Default::default()
    };
    let code_font = crate::ui::theme::code_font(&cx.text_system().all_font_names());
    let attachment = crate::ui::source::agent::Attachment::start(data);
    let window = cx.open_window(options, move |window, cx| {
        window.set_zoom(scale, cx);
        // Butler's Electron window uses the acrylic material; where the platform has none the
        // shell paints an opaque fallback.
        window.set_background_appearance(WindowBackgroundAppearance::Acrylic);
        let options = ShellOptions {
            source: None,
            dark: None,
            code_font,
            locale,
            platform: Platform::host(),
            saved,
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

/// The tray's Open and the dock's reopen: the main window comes forward, or opens when there is
/// none. A browser popup window is not one.
pub(crate) fn reopen(cx: &mut App) {
    launched(cx, &[]);
}

/// A later launch (`second-instance`, main.mjs:455-465) and the tray's New Chat and recent
/// conversations: `args` navigate in the open window, else open a new one, and the App comes
/// forward. Nothing while quitting.
pub(crate) fn launched(cx: &mut App, args: &[String]) {
    if super::runtime(cx).is_some_and(|runtime| runtime.read(cx).quitting()) {
        return;
    }
    let shell = cx
        .windows()
        .into_iter()
        .find_map(|handle| handle.downcast::<Shell>());
    let Some(shell) = shell else {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        if let Err(error) = open_window(cx, &args) {
            eprintln!("butler-shell: {error:#}");
        }
        return;
    };
    let request = crate::ui::shell::navigation::Navigation::from_args(args);
    let _ = shell.update(cx, |view, window, cx| {
        if let Some(request) = request {
            view.navigate(request, window, cx);
        }
        window.activate();
    });
    cx.activate(true);
}

/// The last window closed: quit when the tray is off or failed to start; otherwise the App
/// keeps running with the tray and the Agent.
pub(super) fn closed(cx: &mut App) {
    if !cx.windows().is_empty() {
        return;
    }
    if !super::tray::active(cx) {
        super::quit(cx);
    }
}
