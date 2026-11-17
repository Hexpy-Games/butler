//! SIGTERM (and SIGINT) end the App as the menu Quit does.
use futures::StreamExt as _;
use gpui::App;

/// Starts listening for the host's stop requests; each one is a Quit ([`super::quit`]).
///
/// Call this AFTER the in-app CEF runtime has started (or failed to). CEF's start-up installs its
/// own signal handlers, and `quit_signals` replaces them (it does not chain them): Chromium's own
/// shutdown would kill the browser before our quit flushes it. Installed earlier, CEF's start-up
/// would replace ours.
pub(crate) fn listen(cx: &mut App) {
    let (requests, mut requested) = futures::channel::mpsc::unbounded::<()>();
    let installed = butler_cef_host::quit_signals::install(move || {
        let _ = requests.unbounded_send(());
    });
    if installed.is_err() {
        return;
    }
    cx.spawn(async move |cx| {
        while requested.next().await.is_some() {
            cx.update(super::quit);
        }
    })
    .detach();
}
