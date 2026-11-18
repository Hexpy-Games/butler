//! SIGTERM (and SIGINT) end the App as the menu Quit does.
use std::sync::Once;

use futures::StreamExt as _;
use gpui::App;

/// Makes each stop request a Quit ([`super::quit`]). Call it at App start and again right after
/// CEF starts: CEF's start-up installs its own signal handlers, and `quit_signals` replaces them
/// (it does not chain them), because Chromium's own shutdown would kill the browser before our
/// quit flushes it. Only the first call starts the listener; every call replaces the handlers.
pub(crate) fn listen(cx: &mut App) {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let (requests, mut requested) = futures::channel::mpsc::unbounded::<()>();
        let started = butler_cef_host::quit_signals::start(move || {
            let _ = requests.unbounded_send(());
        });
        if started.is_ok() {
            cx.spawn(async move |cx| {
                while requested.next().await.is_some() {
                    cx.update(super::quit);
                }
            })
            .detach();
        }
    });
    let _ = butler_cef_host::quit_signals::replace_handlers();
}
