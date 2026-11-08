//! The full reset (`app-full-reset.mjs`): the Agent's admin `/data/reset` with its nonce, then
//! stop the child and relaunch. No renderer storage exists to clear; the browser profile is P5.
use butler_ds::ui::context::{Ds, Lang};
use butler_shell_client::{Error, ShellClient};
use gpui::{App, SharedString, Task};
use serde_json::json;

use super::supervisor::StopReason;
use crate::ui::source::agent::Jobs;

/// The fixed token the Agent checks (`FULL_RESET_CONFIRMATION`); the phrase the owner types never
/// leaves the dialog.
const CONFIRMATION: &str = "reset-all-data";

/// settings.memory.resetFailed
fn failed(lang: Lang) -> SharedString {
    match lang {
        Lang::Ko => "초기화하지 못했습니다".into(),
        Lang::En => "Couldn't reset".into(),
    }
}

/// `requestFullReset`: GET the nonce, then POST the reset (202).
async fn request(client: ShellClient, operation_id: String) -> Result<(), Error> {
    let answer = client.get_data_reset_nonce().await?;
    let nonce = answer
        .get("nonce")
        .and_then(|nonce| nonce.as_str())
        .ok_or(Error::Protocol)?;
    let body = json!({
        "operation_id": operation_id,
        "nonce": nonce,
        "confirmation": CONFIRMATION,
    });
    client.start_data_reset(&body).await.map(|_| ())
}

/// Resets all data and relaunches; the error is the message to show. Once the Agent accepted, every
/// later step that fails still relaunches: the Agent applies an accepted reset itself.
pub(crate) fn full_reset(cx: &mut App) -> Task<Result<(), SharedString>> {
    let message = failed(Ds::get(cx).lang());
    let operation_id = uuid::Uuid::new_v4().to_string();
    let accepted = Jobs::run(cx, move |client| request(client, operation_id));
    cx.spawn(async move |cx| {
        if !matches!(accepted.await, Some(Ok(()))) {
            return Err(message);
        }
        let stop = cx.update(|cx| {
            super::runtime(cx)
                .map(|runtime| runtime.read(cx).supervisor.stop(StopReason::FullReset))
        });
        if let Some(stop) = stop {
            let _ = stop.await;
        }
        cx.update(App::restart);
        Ok(())
    })
}
