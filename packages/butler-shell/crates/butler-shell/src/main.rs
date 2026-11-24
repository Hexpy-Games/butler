//! butler-shell (실험): Butler's experimental native desktop shell on gpui.
//!
//! The UI reads data only through [`ui::source::Source`], attached to the local agent
//! with an owned background runtime and filesystem-driven discovery. [`lifecycle`] keeps the
//! App's own child Agent running, as Electron's foreground mode does.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lifecycle;
mod ui;

use std::ffi::OsString;

use gpui::{App, QuitMode};
use gpui_platform::application;

use ui::shell::Quit;

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

/// One App per data folder (main.mjs:432-466): the arguments of later launches. Exits when
/// another App has the folder. `None` for a legacy folder, which is read only and takes no
/// lock, and when the endpoint cannot be opened.
fn single_instance(args: &[OsString]) -> Option<tokio::sync::mpsc::UnboundedReceiver<Vec<String>>> {
    use butler_platform::app_instance::{Launch, claim};
    let data = lifecycle::data_root(args);
    if lifecycle::legacy_data(&data) {
        return None;
    }
    let forwarded: Vec<String> = args
        .iter()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    match claim(&data, &forwarded) {
        Ok(Launch::Forwarded) => std::process::exit(0),
        Ok(Launch::First(launches)) => Some(launches),
        Err(error) => {
            eprintln!("butler-shell: single instance unavailable ({error})");
            None
        }
    }
}

fn main() {
    // CEF runs in this process.
    #[cfg(feature = "cef")]
    butler_cef_host::shorten_temp_path();
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
    let launches = single_instance(&args);
    let app = application()
        .with_assets(ui::assets::Assets)
        .with_quit_mode(QuitMode::Explicit);
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
                // A link Butler reads opens its conversation in the main window, opening one if
                // it is closed.
                if let Some(url) = urls
                    .into_iter()
                    .find(|url| ui::shell::navigation::Navigation::from_url(url).is_some())
                {
                    cx.update(|cx| lifecycle::window::launched(cx, &[url]));
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
            // A start that failed is not a clean exit: the quit observers still run first (the
            // Agent's lease is released), then the process ends with 1. The quit runs as a task,
            // because Linux's event loop drops a stop requested before it starts.
            cx.on_app_quit(|_| async { std::process::exit(1) }).detach();
            cx.spawn(async move |cx| cx.update(|cx| cx.quit())).detach();
            return;
        }
        // Later launches are read only once the first window exists.
        if let Some(mut launches) = launches {
            cx.spawn(async move |cx| {
                while let Some(args) = launches.recv().await {
                    cx.update(|cx| lifecycle::window::launched(cx, &args));
                }
            })
            .detach();
        }
    });
}
