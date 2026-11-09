//! `imageSettingsState.useImageModelReady`: an image model with a credential is chosen.
use gpui::{App, Global};
use serde::Deserialize;

use crate::ui::source::agent::Jobs;

#[derive(Default)]
struct Ready {
    ready: Option<bool>,
    reading: bool,
}

impl Global for Ready {}

#[derive(Deserialize)]
struct Settings {
    #[serde(default)]
    selected: Option<Selected>,
}

#[derive(Deserialize)]
struct Selected {
    #[serde(default)]
    credential_id: Option<String>,
}

/// Whether editing can start. The settings are read once, on the first ask; an unread or
/// unreadable answer is "no model" until [`refresh`] reads again.
pub(super) fn model_ready(cx: &mut App) -> bool {
    let state = cx.default_global::<Ready>();
    let (ready, reading) = (state.ready, state.reading);
    if ready.is_none() && !reading {
        refresh(cx);
    }
    ready.unwrap_or(false)
}

/// `refreshImageSettings`: reads `GET /settings/image-model` again.
pub(super) fn refresh(cx: &mut App) {
    if Jobs::client(cx).is_none() || cx.default_global::<Ready>().reading {
        return;
    }
    cx.default_global::<Ready>().reading = true;
    let job = Jobs::run(cx, |client| async move {
        let settings = client.get_image_model_settings().await.ok()?;
        serde_json::from_value::<Settings>(settings).ok()
    });
    cx.spawn(async move |cx| {
        let settings = job.await.flatten();
        cx.update(|cx| {
            let state = cx.default_global::<Ready>();
            state.reading = false;
            state.ready = Some(
                settings
                    .and_then(|settings| settings.selected)
                    .is_some_and(|selected| selected.credential_id.is_some()),
            );
            cx.refresh_windows();
        });
    })
    .detach();
}
