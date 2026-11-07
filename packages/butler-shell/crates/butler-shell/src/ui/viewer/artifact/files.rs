//! `useArtifactText` and the save of `artifactActions`: a text artifact's content, fetched once
//! per stored file on the agent worker, and the save dialog that writes a file to disk.
use std::collections::HashMap;
use std::path::PathBuf;

use butler_ds::ui::toast::{self, Toast};
use gpui::{App, SharedString};

use crate::ui::i18n::media::Media;
use crate::ui::source::agent::Jobs;

/// Where one text stands.
enum Load {
    Pending,
    Ready(SharedString),
    Failed,
}

#[derive(Default)]
struct Texts(HashMap<String, Load>);

impl gpui::Global for Texts {}

/// `ArtifactTextState` with the text.
pub(super) enum TextState {
    Loading,
    Failed,
    Ready(SharedString),
}

/// The text of message file `file_id`; starts the download the first time it is asked for.
/// The windows refresh when it arrives.
pub(super) fn artifact_text(file_id: &str, cx: &mut App) -> TextState {
    match cx.default_global::<Texts>().0.get(file_id) {
        Some(Load::Ready(text)) => return TextState::Ready(text.clone()),
        Some(Load::Failed) => return TextState::Failed,
        Some(Load::Pending) => return TextState::Loading,
        None => {}
    }
    if Jobs::client(cx).is_none() {
        return TextState::Loading;
    }
    cx.default_global::<Texts>()
        .0
        .insert(file_id.to_owned(), Load::Pending);
    let (key, wanted) = (file_id.to_owned(), file_id.to_owned());
    let done = Jobs::run(cx, move |client| async move {
        let file = client.download_message_file(&wanted).await.ok()?;
        Some(String::from_utf8_lossy(&file.bytes).into_owned())
    });
    cx.spawn(async move |cx| {
        let loaded = done.await;
        cx.update(|cx| {
            let texts = cx.default_global::<Texts>();
            match loaded {
                Some(text) => {
                    let state = text.map_or(Load::Failed, |text| Load::Ready(text.into()));
                    texts.0.insert(key, state);
                }
                // The agent detached before the download ended: ask again after the next attach.
                None => {
                    texts.0.remove(&key);
                }
            }
        });
        cx.refresh();
    })
    .detach();
    TextState::Loading
}

/// `saveDesktopArtifact`: the save dialog, then the download written to the chosen path.
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
        let written = match download.await.flatten() {
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
