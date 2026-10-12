//! Undo secrets stay in the system credential store, keyed by import run and entry.
use super::{HttpError, HttpState, signin_secrets};
use crate::gateway::AppSignInCommand;
use butler_platform::secrets::SecretText;
use serde_json::{Value, json};
use std::sync::Arc;
fn backup(run: &str, id: &str) -> String {
    format!("import:{run}:{id}")
}

pub(in crate::gateway::http) async fn replace(
    state: &Arc<HttpState>,
    id: &str,
    run: &str,
    time: i64,
    secret: SecretText,
) -> Result<Value, HttpError> {
    let previous = signin_secrets::get(state, id)
        .await?
        .ok_or(HttpError::Internal)?;
    let key = backup(run, id);
    let new_backup = signin_secrets::get(state, &key).await?.is_none();
    if new_backup {
        signin_secrets::set(state, &key, SecretText::new(previous.expose().into())).await?;
    }
    if let Err(error) = signin_secrets::set(state, id, secret).await {
        if new_backup {
            signin_secrets::delete(state, &key).await?;
        }
        return Err(error);
    }
    if let Err(error) = state
        .application
        .signins(AppSignInCommand::FinishImportUpdate {
            id: id.into(),
            run_id: run.into(),
            modified_ms: time,
        })
        .await
    {
        signin_secrets::set(state, id, previous).await?;
        if new_backup {
            signin_secrets::delete(state, &key).await?;
        }
        return Err(error.into());
    }
    Ok(json!({"id":id,"action":"updated"}))
}
pub(super) async fn restore(
    state: &Arc<HttpState>,
    row: &Value,
    run: &str,
) -> Result<bool, HttpError> {
    let id = row["id"].as_str().ok_or(HttpError::Internal)?;
    let key = backup(run, id);
    let restored = if row["current"] == true {
        let previous = signin_secrets::get(state, &key)
            .await?
            .ok_or(HttpError::Internal)?;
        let current = signin_secrets::get(state, id)
            .await?
            .ok_or(HttpError::Internal)?;
        signin_secrets::set(state, id, previous).await?;
        let result = state
            .application
            .signins(AppSignInCommand::RestoreImportUpdate {
                id: id.into(),
                run_id: run.into(),
            })
            .await;
        match result {
            Ok(result) => result["restored"] == true,
            Err(error) => {
                signin_secrets::set(state, id, current).await?;
                return Err(error.into());
            }
        }
    } else {
        state
            .application
            .signins(AppSignInCommand::RestoreImportUpdate {
                id: id.into(),
                run_id: run.into(),
            })
            .await?;
        false
    };
    signin_secrets::delete(state, &key).await?;
    Ok(restored)
}
