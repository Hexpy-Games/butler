//! The file actions the transcript's file rows share: a message file's picture
//! (`useMessageFileSource`), save and save to the Library. Each runs its client call on the
//! agent worker through `Jobs`.
use std::path::PathBuf;

use butler_ds::ui::toast::{self, Toast};
use gpui::{App, ImageSource};

use crate::ui::i18n::media::Media;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::source::agent::Jobs;

/// The picture of message file `file_id` once it is loaded; starts the download the first time
/// it is asked for.
pub(super) fn file_picture(file_id: &str, cx: &mut App) -> Option<ImageSource> {
    picture(&PictureId::File(file_id.to_owned()), cx).map(ImageSource::Image)
}

/// The save of a message file: the save dialog, then the download written to the chosen path.
pub(super) fn save_file(file_id: String, name: &str, cx: &mut App) {
    let directory = butler_platform::user_dirs::non_empty_home_dir()
        .map_or_else(PathBuf::new, |home| home.join("Downloads"));
    let ask = cx.prompt_for_new_path(&directory, Some(name));
    let copy = Media::get(cx);
    let download = Jobs::run(cx, move |client| async move {
        let file = client.download_message_file(&file_id).await.ok()?;
        Some(file.bytes)
    });
    cx.spawn(async move |cx| {
        let Ok(Ok(Some(path))) = ask.await else {
            return;
        };
        let bytes = download.await.flatten();
        let written = match bytes {
            Some(bytes) => cx
                .background_executor()
                .spawn(async move { std::fs::write(path, bytes).ok() })
                .await
                .is_some(),
            None => false,
        };
        cx.update(|cx| {
            let toast = if written {
                Toast::success(copy.artifact_saved)
            } else {
                Toast::error(copy.artifact_save_failed)
            };
            toast::show(cx, toast);
        });
    })
    .detach();
}

/// `addWorkingFileToLibrary`: saves a file the turn made to the Library.
pub(super) fn add_to_library(file_id: String, cx: &mut App) {
    let copy = Media::get(cx);
    let saved = Jobs::run(cx, move |client| async move {
        let body = serde_json::json!({ "file_id": file_id });
        client.save_library_document(&body).await.ok().map(|_| ())
    });
    cx.spawn(async move |cx| {
        let done = saved.await.flatten().is_some();
        cx.update(|cx| {
            let toast = if done {
                Toast::success(copy.saved_to_library)
            } else {
                Toast::error(copy.action_failed)
            };
            toast::show(cx, toast);
        });
    })
    .detach();
}
