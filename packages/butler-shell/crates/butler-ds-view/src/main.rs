//! butler-ds-view: the native DS View. A window with a sidebar of showcase pages, one per DS
//! primitive, mirroring the React DS Viewer's showcase files (same examples, order and copy,
//! English and Korean). Not shipped.
//!
//!   butler-ds-view
//!   butler-ds-view --shots <dir> --scale 2 --size 1280x800 [--dark] [--lang ko|en]
//!       (feature `shots`: renders every page headless to `<dir>/<page>.png`)
mod app;
mod copy;
mod pages;
#[cfg(feature = "shots")]
mod shots;
mod standins;

use butler_ds::ui::assets::Assets;
use gpui::{App, AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};
use gpui_platform::application;

use app::DsView;
use copy::Lang;

fn open(cx: &mut App, dark: bool, lang: Lang) -> anyhow::Result<()> {
    let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        ..Default::default()
    };
    cx.open_window(options, |window, cx| {
        app::install(cx, dark, lang);
        cx.new(|cx| {
            let mut view = DsView::new(window, cx);
            view.lang = lang;
            view
        })
    })?;
    cx.on_window_closed(|cx, _| cx.quit()).detach();
    Ok(())
}

fn main() -> std::process::ExitCode {
    #[cfg(feature = "shots")]
    if std::env::args_os().any(|arg| arg == "--shots") {
        return shots::main();
    }
    let args: Vec<_> = std::env::args_os().collect();
    let dark = args.iter().any(|arg| arg == "--dark");
    let lang = if args
        .windows(2)
        .any(|pair| pair[0] == "--lang" && pair[1] == "en")
    {
        Lang::En
    } else {
        Lang::Ko
    };
    application().with_assets(Assets).run(move |cx: &mut App| {
        if let Err(error) = app::init(cx).and_then(|()| open(cx, dark, lang)) {
            eprintln!("butler-ds-view: {error:#}");
            cx.quit();
        }
    });
    std::process::ExitCode::SUCCESS
}
