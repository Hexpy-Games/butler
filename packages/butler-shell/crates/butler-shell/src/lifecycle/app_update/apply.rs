//! `applyUpdate` of the preload (`preload.cjs:881-905`): the one path every caller takes.
use gpui::{App, SharedString, Task};
use serde_json::{Value, json};

use super::{AppUpdateStatus, open_staged, status};
use crate::ui::source::agent::Jobs;

/// POST /updates/apply; a staged App package is then handed to the installer
/// (`butler:open-update-artifact`). The answer carries `app_restart_status` in that case.
pub(crate) fn apply(request: Value, cx: &mut App) -> Task<Result<Value, SharedString>> {
    cx.spawn(async move |cx| {
        let sent = cx
            .update(|app| {
                Jobs::run(app, move |client| async move {
                    client.apply_update(&request).await
                })
            })
            .await;
        let Some(Ok(mut result)) = sent else {
            return Err(SharedString::from("update_apply_failed"));
        };
        let path = result
            .get("artifact_path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let staged = result.get("component").and_then(Value::as_str) == Some("app")
            && result.get("stage_status").and_then(Value::as_str) == Some("staged");
        let Some(path) = path.filter(|_| staged) else {
            return Ok(result);
        };
        let staged = json!({ "artifact_path": path });
        cx.update(|app| open_staged(&staged, app)).await?;
        let restart = cx.update(|app| restart_status(&status(app)));
        if let Some(fields) = result.as_object_mut() {
            fields.insert("app_restart_status".to_owned(), json!(restart));
        }
        Ok(result)
    })
}

fn restart_status(status: &AppUpdateStatus) -> &'static str {
    match status {
        AppUpdateStatus::Idle => "idle",
        AppUpdateStatus::ChoiceRequired(_) => "choice_required",
        AppUpdateStatus::Deferred => "deferred",
        AppUpdateStatus::Preparing => "preparing",
        AppUpdateStatus::Restarting => "restarting",
        AppUpdateStatus::Failed => "failed",
    }
}
