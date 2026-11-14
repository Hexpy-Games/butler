//! The App window: opening it (at startup, from the tray, on a dock reopen) and what closing
//! the last one does (main.mjs:2067-2074, 2767-2770). Electron hides the window; gpui drops it
//! and the next [`open_window`] builds a new shell that re-attaches and reloads from the Agent.
use std::ffi::OsString;

use gpui::{
    App, AppContext as _, Bounds, Pixels, Point, Size, TitlebarOptions, Window,
    WindowBackgroundAppearance, WindowBounds, WindowOptions, point, px, size,
};

/// `macTrafficLightPosition` (Electron main.mjs:281): the close button's top-left inset, which
/// centres the buttons on the title row. gpui re-applies it on resize and on leaving fullscreen.
const TRAFFIC_LIGHTS: (f32, f32) = (20., 18.);

/// `scaledWindowButtonPosition` (text-size.mjs): button centers follow the titlebar height;
/// native button diameter stays constant. Applied when the window opens and when the text size
/// changes.
fn scaled_traffic_lights(scale: f32) -> Point<Pixels> {
    point(
        px((TRAFFIC_LIGHTS.0 * scale).round()),
        px(((TRAFFIC_LIGHTS.1 + 7.) * scale - 7.).round()),
    )
}

/// Minimum window size (main.mjs:2020-2021 / text-size.mjs `updateWindow`).
fn min_size(scale: f32, area: Option<Size<Pixels>>) -> Size<Pixels> {
    let minimum = size(px((344. * scale).ceil()), px((480. * scale).ceil()));
    match area {
        Some(area) => size(
            minimum.width.min(area.width),
            minimum.height.min(area.height),
        ),
        None => minimum,
    }
}

/// `updateWindow` (text-size.mjs): native window metrics follow the text scale.
pub(crate) fn apply_text_scale(window: &Window, scale: f32, cx: &App) {
    window.set_traffic_light_position(scaled_traffic_lights(scale));
    window.set_window_min_size(min_size(
        scale,
        window
            .display(cx)
            .map(|display| display.visible_bounds().size),
    ));
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
            traffic_light_position: Some(scaled_traffic_lights(scale)),
        }),
        window_min_size: Some(min_size(scale, None)),
        app_id: Some("butler-shell".into()),
        ..Default::default()
    };
    let code_font = crate::ui::theme::code_font(&cx.text_system().all_font_names());
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
