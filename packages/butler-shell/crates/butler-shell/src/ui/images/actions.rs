//! `GeneratedImageActions.tsx`: edit, save to 서랍 and download, under a generated image and in
//! the image viewer.
use std::path::PathBuf;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::done_icon_button::{DoneIconButton, Outcome};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::toast::{self, Toast};
use gpui::{AnyElement, App, IntoElement as _, SharedString, Task};

use super::copy::{Words, words};
use super::{ImageAsset, open_editor, read_only, ready};
use crate::ui::source::agent::Jobs;

/// Why editing is unavailable: a read-only chat or no image model.
pub(super) fn edit_blocked(copy: &Words, cx: &mut App) -> Option<&'static str> {
    if read_only(cx) {
        Some(copy.read_only)
    } else if !ready::model_ready(cx) {
        Some(copy.no_model)
    } else {
        None
    }
}

/// `saveGeneratedImage`: `POST /library` with the picture as a scrap of the conversation.
fn save(
    asset: &ImageAsset,
    session: &str,
    title: &str,
    failed: &'static str,
    cx: &mut App,
) -> Task<Outcome> {
    let body = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(), "kind": "scrap", "title": title, "url": "",
        "asset": asset.id, "text": "", "session": session,
        "capturedAt": chrono::Utc::now().to_rfc3339(),
    });
    let job = Jobs::run(cx, move |client| async move {
        client.save_library(&body).await.ok().map(|_| ())
    });
    cx.spawn(async move |_| {
        job.await
            .flatten()
            .ok_or_else(|| SharedString::from(failed))
    })
}

/// `downloadGeneratedImage`: the save dialog, then the picture written to the chosen path.
fn download(asset: &ImageAsset, failed: &'static str, cx: &mut App) {
    let extension = match asset.mime.as_deref() {
        Some("image/webp") => "webp",
        Some("image/jpeg") => "jpg",
        _ => "png",
    };
    let name = format!("{}.{extension}", asset.id);
    let directory = butler_platform::user_dirs::non_empty_home_dir()
        .map_or_else(PathBuf::new, |home| home.join("Downloads"));
    let ask = cx.prompt_for_new_path(&directory, Some(&name));
    let id = asset.id.clone();
    let job = Jobs::run(cx, move |client| async move {
        let file = client.download_message_asset(&id, true).await.ok()?;
        Some(file.bytes)
    });
    cx.spawn(async move |cx| {
        let Ok(Ok(Some(path))) = ask.await else {
            return;
        };
        let written = match job.await.flatten() {
            Some(bytes) => cx
                .background_executor()
                .spawn(async move { std::fs::write(path, bytes).ok() })
                .await
                .is_some(),
            None => false,
        };
        if !written {
            cx.update(|cx| {
                toast::show(cx, Toast::error(failed));
            });
        }
    })
    .detach();
}

/// The three buttons, `key` making their ids unique.
pub(super) fn buttons(
    asset: &Rc<ImageAsset>,
    session: &str,
    title: &str,
    key: &str,
    cx: &mut App,
) -> Vec<AnyElement> {
    let copy = words(Ds::get(cx).lang());
    let blocked = edit_blocked(copy, cx);
    let mut edit = IconButton::new(
        SharedString::from(format!("{key}-edit")),
        blocked.unwrap_or(copy.edit),
    )
    .glyph(Icon::Pencil);
    if blocked.is_some() {
        edit = edit.disabled();
    } else {
        let (asset, session) = (asset.clone(), SharedString::from(session.to_owned()));
        edit = edit.on_click(move |_, _, cx| open_editor(session.clone(), asset.clone(), cx));
    }
    let (saved, session_id, name) = (asset.clone(), session.to_owned(), title.to_owned());
    let failed = copy.action_failed;
    let save_button = DoneIconButton::new(
        SharedString::from(format!("{key}-save")),
        copy.save_to_library,
        copy.saved_to_library,
    )
    .icon(icon(Icon::Library, IconSize::Sm, Ds::get(cx)))
    .on_action(move |_, cx| save(&saved, &session_id, &name, failed, cx))
    .on_error(|message, cx| {
        toast::show(cx, Toast::error(message.clone()));
    });
    let downloaded = asset.clone();
    let download_button =
        IconButton::new(SharedString::from(format!("{key}-download")), copy.download)
            .glyph(Icon::Download)
            .on_click(move |_, _, cx| download(&downloaded, failed, cx));
    vec![
        edit.into_any_element(),
        save_button.into_any_element(),
        download_button.into_any_element(),
    ]
}
