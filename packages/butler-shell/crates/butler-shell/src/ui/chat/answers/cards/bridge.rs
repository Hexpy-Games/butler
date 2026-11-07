//! The card's calls to the app's client. The client's futures need a Tokio reactor, which the UI
//! executor has not, so each call runs on its own short-lived thread and the UI awaits the result.
use std::future::Future;
use std::sync::Arc;

use butler_ds::ui::done_icon_button::Outcome;
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{App, Image, ImageFormat, SharedString, Task, Window};
use serde_json::Value;

/// Runs `work` to completion on a current-thread Tokio runtime of its own.
fn run<T: Send + 'static>(
    work: impl Future<Output = Result<T, String>> + Send + 'static,
) -> oneshot::Receiver<Result<T, String>> {
    let (send, receive) = oneshot::channel();
    std::thread::spawn(move || {
        let result = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(work),
            Err(error) => Err(error.to_string()),
        };
        let _ = send.send(result);
    });
    receive
}

/// `GET /message-assets/{asset}`: a card's picture, decoded by the image element.
pub(super) fn picture(
    client: ShellClient,
    asset: String,
) -> oneshot::Receiver<Result<Arc<Image>, String>> {
    run(async move {
        let file = client
            .download_message_asset(&asset, false)
            .await
            .map_err(|error| error.to_string())?;
        let mime = file.content_type.as_deref().unwrap_or_default();
        let format = ImageFormat::from_mime_type(mime.split(';').next().unwrap_or_default().trim())
            .ok_or_else(|| format!("unsupported picture type {mime}"))?;
        Ok(Arc::new(Image::from_bytes(format, file.bytes)))
    })
}

/// `POST /library`: saves a scrap; the task resolves when the server has it.
pub(super) fn save(
    client: Option<ShellClient>,
    body: Value,
    failed: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Task<Outcome> {
    window.spawn(cx, async move |_| {
        let Some(client) = client else {
            return Err(failed);
        };
        let saved = run(async move {
            client
                .save_library(&body)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .await;
        match saved {
            Ok(Ok(())) => Ok(()),
            _ => Err(failed),
        }
    })
}
