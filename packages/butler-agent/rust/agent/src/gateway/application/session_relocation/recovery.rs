//! Forward recovery and identity-safe cleanup for durable relocation records.

use std::process::{Command, Stdio};

use super::super::{
    AppApplication, AppRelocationCanonicalUpdate, AppRelocationWorkspacePlan, app_error,
};
use super::records::{self, Row};
use crate::gateway::{GatewayApplicationError, app_session_hint};

pub(super) async fn recover_one(
    app: &AppApplication,
    row: Row,
    _startup: bool,
) -> Result<(), GatewayApplicationError> {
    if row.phase == "committed" {
        return Ok(());
    }
    if row.phase == "aborted" {
        return cleanup_aborted(app, row).await;
    }
    let before = records::decode_before(&row)?;
    if before.owner_pid != std::process::id() && process_is_alive(before.owner_pid) {
        return Ok(());
    }
    let runtime_session_id = app_session_hint(&row.session_id);
    let snapshot = app
        .dependencies
        .relocation_host
        .inspect(runtime_session_id.clone())
        .await?;
    let relocation_applied = snapshot
        .binding
        .as_ref()
        .and_then(|binding| binding.metadata.as_ref())
        .and_then(|metadata| metadata.get("relocationId"))
        .and_then(serde_json::Value::as_str)
        == Some(row.operation_id.as_str());
    if relocation_applied {
        return finish(app, row, runtime_session_id).await;
    }
    if row.phase == "preparing"
        || snapshot
            .binding
            .as_ref()
            .map(|binding| binding.updated_at.as_str())
            == before
                .binding
                .as_ref()
                .map(|binding| binding.updated_at.as_str())
    {
        return abort(app, row).await;
    }
    Err(public(
        "session_context_conflict",
        "대화 이동의 실행 환경을 확인해야 합니다. 기존 작업은 보존되어 있습니다.",
    ))
}

async fn finish(
    app: &AppApplication,
    row: Row,
    runtime_session_id: String,
) -> Result<(), GatewayApplicationError> {
    let plan: AppRelocationWorkspacePlan = row
        .prepared_json
        .as_deref()
        .ok_or_else(|| {
            public(
                "relocation_preparation_missing",
                "이동 준비 정보를 확인할 수 없습니다.",
            )
        })
        .and_then(|value| {
            serde_json::from_str(value).map_err(|_| GatewayApplicationError::Internal)
        })?;
    if plan.operation_id != row.operation_id || plan.runtime_session_id != runtime_session_id {
        return Err(GatewayApplicationError::Internal);
    }
    let destination = records::decode_destination(&row)?;
    app.dependencies
        .relocation_host
        .sync_conversation_context(AppRelocationCanonicalUpdate {
            runtime_session_id,
            project_id: destination
                .project
                .as_ref()
                .map(|project| project.id.clone()),
            revision: row.operation_id.clone(),
        })
        .await?;
    app.space_mutations
        .commit_relocation(
            &app.storage,
            &app.subscribers,
            app.dependencies.identity_clock.clone(),
            row.operation_id,
            row.session_id,
            destination,
        )
        .await?;
    Ok(())
}

async fn abort(app: &AppApplication, row: Row) -> Result<(), GatewayApplicationError> {
    app.storage
        .execute({
            let row = row.clone();
            move |db| Ok(records::abort(db, &row, "relocation_not_applied"))
        })
        .await
        .map_err(app_error)??;
    cleanup_plan(app, row).await
}

async fn cleanup_aborted(app: &AppApplication, row: Row) -> Result<(), GatewayApplicationError> {
    cleanup_plan(app, row).await
}

async fn cleanup_plan(app: &AppApplication, row: Row) -> Result<(), GatewayApplicationError> {
    let Some(encoded) = row.prepared_json.as_deref() else {
        return Ok(());
    };
    let Ok(plan) = serde_json::from_str::<AppRelocationWorkspacePlan>(encoded) else {
        return Err(GatewayApplicationError::Internal);
    };
    if plan.operation_id != row.operation_id
        || plan.runtime_session_id != app_session_hint(&row.session_id)
    {
        return Err(GatewayApplicationError::Internal);
    }
    if app
        .dependencies
        .relocation_host
        .discard_workspace(plan)
        .await?
    {
        let operation_id = row.operation_id;
        app.storage
            .execute(move |db| Ok(records::clear_plan(db, &operation_id)))
            .await
            .map_err(app_error)??;
    }
    Ok(())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("/bin/kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_or(true, |status| status.success())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn public(code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
