//! The card's calls to the app's client, run on the agent worker (`Jobs`).
use butler_ds::ui::done_icon_button::Outcome;
use gpui::{App, SharedString, Task, Window};
use serde_json::Value;

use crate::ui::source::agent::Jobs;

/// `POST /library`: saves a scrap; the task resolves when the server has it.
pub(super) fn save(
    body: Value,
    failed: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Task<Outcome> {
    let saved = Jobs::run(cx, move |client| async move {
        client.save_library(&body).await.ok().map(|_| ())
    });
    window.spawn(cx, async move |_| match saved.await.flatten() {
        Some(()) => Ok(()),
        None => Err(failed),
    })
}
