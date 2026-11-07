//! Runs one `ShellClient` call on the agent worker (`Jobs`). The receiver yields the value or
//! the (credential-safe) error text, and is cancelled when no agent is attached.
use futures::channel::oneshot;
use gpui::App;

use crate::ui::source::agent::Jobs;

/// Starts `work`; the receiver yields its value or the error text.
pub(super) fn run<T: Send + 'static>(
    cx: &App,
    work: impl Future<Output = Result<T, butler_shell_client::Error>> + Send + 'static,
) -> oneshot::Receiver<Result<T, String>> {
    let (send, receive) = oneshot::channel();
    let done = Jobs::run(cx, move |_client| async move {
        work.await.map_err(|error| error.to_string())
    });
    cx.spawn(async move |_| {
        if let Some(result) = done.await {
            let _ = send.send(result);
        }
    })
    .detach();
    receive
}
