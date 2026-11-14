//! butler-shell (실험): Butler's experimental native desktop shell on gpui.
//!
//! The UI reads data only through [`ui::source::Source`], attached to the local agent
//! with an owned background runtime and filesystem-driven discovery. [`lifecycle`] keeps the
//! App's own child Agent running, as Electron's foreground mode does.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lifecycle;
mod ui;

use std::ffi::OsString;

use gpui::App;
use gpui_platform::application;

use ui::shell::{Quit, Shell};

/// Electron's Windows AppUserModelID (main.mjs:203); a no-op elsewhere.
const APP_ID: &str = butler_platform::app_shell::WINDOWS_APP_ID;

/// The startup order of `main.mjs`: the data folder, the lifecycle, the Agent, then the window.
fn start(cx: &mut App, args: &[OsString]) -> anyhow::Result<()> {
    ui::init(cx)?;
    let data = lifecycle::data_root(args);
    let legacy = lifecycle::legacy_data(&data);
    lifecycle::init(cx, data, legacy);
    // The Agent's boot is the long pole and needs no window; the first frame reads its state.
    if !legacy {
        lifecycle::ensure_ready(cx);
    }
    cx.set_app_identity(APP_ID, "Butler");
    lifecycle::window::open_window(cx, args)?;
    Ok(())
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if let Some(event) = butler_platform::squirrel::event(&args) {
        let data = lifecycle::data_root(&args);
        let owned = !args.iter().any(|arg| arg == "--data")
            && std::env::var_os("BUTLER_DATA").is_none_or(|value| value.is_empty());
        let result = std::env::current_exe()
            .map_err(|_| "Squirrel executable unavailable".to_owned())
            .and_then(|executable| {
                butler_platform::squirrel::handle(event, &executable, &data, owned)
            });
        let code = match result {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        };
        std::process::exit(code);
    }
    let app = application().with_assets(ui::assets::Assets);
    let (urls, mut incoming) = futures::channel::mpsc::unbounded::<Vec<String>>();
    app.on_open_urls(move |values| {
        let _ = urls.unbounded_send(values);
    });
    app.on_reopen(lifecycle::window::reopen);
    app.run(move |cx: &mut App| {
        cx.on_action(|_: &Quit, cx| lifecycle::quit(cx));
        cx.spawn(async move |cx| {
            use futures::StreamExt as _;
            while let Some(urls) = incoming.next().await {
                let request = urls
                    .iter()
                    .find_map(|url| ui::shell::navigation::Navigation::from_url(url));
                if let Some(request) = request {
                    cx.update(|cx| {
                        // Closed to the tray: the link opens the window first.
                        lifecycle::window::reopen(cx);
                        if let Some(window) = cx
                            .windows()
                            .first()
                            .and_then(gpui::AnyWindowHandle::downcast::<Shell>)
                        {
                            let _ = window.update(cx, |s, w, cx| s.navigate(request, w, cx));
                        }
                    });
                }
            }
        })
        .detach();
        if let Err(error) = start(cx, &args) {
            eprintln!("butler-shell: {error:#}");
            // `handleFatalStartupError`, then the quit that drains the App log.
            let failed = serde_json::json!({});
            lifecycle::logs::app_log("ERROR", "lifecycle", "app.start_failed", failed);
            lifecycle::logs::quit();
            cx.quit();
        }
    });
}
