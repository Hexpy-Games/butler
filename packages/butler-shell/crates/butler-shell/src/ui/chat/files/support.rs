//! The file actions the transcript's file rows share: a message file's picture
//! (`useMessageFileSource`), save, save to the Library and the image viewer. Each runs the
//! client call on a small runtime of its own, as the shell's connection runtime is the agent
//! worker's.
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;

use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{App, BorrowAppContext as _, Image, ImageFormat, ImageSource};

use crate::ui::shell::image_viewer::{ImageViewerHost, ViewerImage};

/// The path prefix of a message file (`MESSAGE_FILE_URL_PATTERN` in `messageFileUrls.ts`).
pub(super) const MESSAGE_FILE_DIR: &str = "/message-files/";

/// The English or the Korean text, by the app language.
pub(super) fn tr(cx: &App, en: &'static str, ko: &'static str) -> &'static str {
    match Ds::get(cx).lang() {
        Lang::En => en,
        Lang::Ko => ko,
    }
}

/// Where one message file's picture stands.
enum Load {
    Pending,
    Ready(ImageSource),
    Failed,
}

#[derive(Default)]
struct Pictures(HashMap<String, Load>);

impl gpui::Global for Pictures {}

/// Runs `work` with a client on a thread of its own; `None` when the thread did not start.
fn run_on_worker<T, F>(
    client: ShellClient,
    work: impl FnOnce(ShellClient) -> F + Send + 'static,
) -> Option<oneshot::Receiver<Option<T>>>
where
    T: Send + 'static,
    F: Future<Output = Option<T>>,
{
    let (send, receive) = oneshot::channel();
    std::thread::Builder::new()
        .name("message-file".into())
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .and_then(|runtime| runtime.block_on(work(client)));
            let _ = send.send(result);
        })
        .ok()?;
    Some(receive)
}

/// The picture of message file `file_id` once it is loaded; starts the download the first time
/// it is asked for.
pub(super) fn picture(
    file_id: &str,
    client: Option<&ShellClient>,
    cx: &mut App,
) -> Option<ImageSource> {
    match cx.default_global::<Pictures>().0.get(file_id) {
        Some(Load::Ready(source)) => return Some(source.clone()),
        Some(Load::Pending | Load::Failed) => return None,
        None => {}
    }
    let client = client?.clone();
    let id = file_id.to_owned();
    let download = id.clone();
    let Some(receive) = run_on_worker(client, move |client| async move {
        let file = client.download_message_file(&download).await.ok()?;
        Some((file.content_type, file.bytes))
    }) else {
        cx.default_global::<Pictures>().0.insert(id, Load::Failed);
        return None;
    };
    cx.default_global::<Pictures>()
        .0
        .insert(id.clone(), Load::Pending);
    cx.spawn(async move |cx| {
        let loaded = receive.await.ok().flatten();
        cx.update(|cx| {
            let state = loaded
                .and_then(|(content_type, bytes)| decode(content_type.as_deref(), bytes))
                .map_or(Load::Failed, Load::Ready);
            cx.default_global::<Pictures>().0.insert(id, state);
        });
        cx.refresh();
    })
    .detach();
    None
}

/// The picture a download carries, by its content type.
fn decode(content_type: Option<&str>, bytes: Vec<u8>) -> Option<ImageSource> {
    let mime = content_type?.split(';').next()?.trim();
    let format = ImageFormat::from_mime_type(mime)?;
    Some(ImageSource::Image(std::sync::Arc::new(Image::from_bytes(
        format, bytes,
    ))))
}

/// Opens the image viewer on `images` at `index`.
pub(super) fn open_viewer(images: Vec<ViewerImage>, index: usize, cx: &mut App) {
    if cx.has_global::<ImageViewerHost>() {
        cx.update_global::<ImageViewerHost, _>(|host, _| host.open(images, index));
        cx.refresh_windows();
    }
}

/// The save of a message file: the save dialog, then the download written to the chosen path.
pub(super) fn save_file(file_id: String, name: String, client: Option<ShellClient>, cx: &mut App) {
    let Some(client) = client else { return };
    let directory = butler_platform::user_dirs::non_empty_home_dir()
        .map_or_else(PathBuf::new, |home| home.join("Downloads"));
    let ask = cx.prompt_for_new_path(&directory, Some(&name));
    let (saved, failed) = (
        tr(cx, "Artifact saved", "아티팩트를 저장했습니다"),
        tr(
            cx,
            "Could not save artifact",
            "아티팩트를 저장하지 못했습니다",
        ),
    );
    cx.spawn(async move |cx| {
        let Ok(Ok(Some(path))) = ask.await else {
            return;
        };
        let written = run_on_worker(client, move |client| async move {
            let file = client.download_message_file(&file_id).await.ok()?;
            std::fs::write(path, file.bytes).ok()
        });
        let done = match written {
            Some(receive) => receive.await.ok().flatten().is_some(),
            None => false,
        };
        cx.update(|cx| {
            let toast = if done {
                Toast::success(saved)
            } else {
                Toast::error(failed)
            };
            toast::show(cx, toast);
        });
    })
    .detach();
}

/// `addWorkingFileToLibrary`: saves a file the turn made to the Library.
pub(super) fn add_to_library(file_id: String, client: Option<ShellClient>, cx: &mut App) {
    let Some(client) = client else { return };
    let (saved, failed) = (
        tr(cx, "Saved to library", "서랍에 저장했어요"),
        tr(cx, "Action failed", "실행하지 못했어요"),
    );
    let Some(receive) = run_on_worker(client, move |client| async move {
        let body = serde_json::json!({ "file_id": file_id });
        client.save_library_document(&body).await.ok().map(|_| ())
    }) else {
        toast::show(cx, Toast::error(failed));
        return;
    };
    cx.spawn(async move |cx| {
        let done = receive.await.ok().flatten().is_some();
        cx.update(|cx| {
            let toast = if done {
                Toast::success(saved)
            } else {
                Toast::error(failed)
            };
            toast::show(cx, toast);
        });
    })
    .detach();
}
