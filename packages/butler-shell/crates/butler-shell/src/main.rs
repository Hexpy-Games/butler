//! butler-shell (실험): Butler's experimental native desktop shell on gpui.
//!
//! The UI reads data only through [`ui::source::Source`], attached to the local agent
//! with an owned background runtime and filesystem-driven discovery.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ui;

use gpui::{
    App, AppContext as _, Bounds, TitlebarOptions, WindowBackgroundAppearance, WindowBounds,
    WindowOptions, px, size,
};
use gpui_platform::application;

use ui::i18n::Locale;
use ui::shell::{Quit, Shell, ShellOptions};

fn open(cx: &mut App) -> anyhow::Result<()> {
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
    let code_font = ui::theme::code_font(&cx.text_system().all_font_names());
    let args: Vec<_> = std::env::args_os().collect();
    let data = args
        .windows(2)
        .find(|p| p[0] == "--data")
        .map(|p| std::path::PathBuf::from(&p[1]));
    let attachment = ui::source::agent::Attachment::start(data);
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
            locale,
        };
        cx.new(|cx| {
            let mut shell = Shell::new(options, window, cx);
            shell.attach(attachment, cx);
            shell
        })
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
        .with_assets(ui::assets::Assets)
        .run(|cx: &mut App| {
            cx.on_action(|_: &Quit, cx| cx.quit());
            if let Err(error) = ui::init(cx).and_then(|()| open(cx)) {
                eprintln!("butler-shell: {error:#}");
                cx.quit();
            }
        });
}
