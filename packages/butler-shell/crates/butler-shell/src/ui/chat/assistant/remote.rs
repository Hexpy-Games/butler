//! Runs one `ShellClient` call. The client's futures need a tokio runtime; gpui has none, so each
//! call runs on its own short-lived thread with a current-thread runtime, and the result comes
//! back on a channel gpui can await.
use futures::channel::oneshot;

/// Starts `work`; the receiver yields its value or the (credential-safe) error text.
pub(super) fn run<T: Send + 'static>(
    work: impl Future<Output = Result<T, butler_shell_client::Error>> + Send + 'static,
) -> oneshot::Receiver<Result<T, String>> {
    let (send, receive) = oneshot::channel();
    std::thread::spawn(move || {
        let result = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(work).map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let _ = send.send(result);
    });
    receive
}
