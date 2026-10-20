//! Reclaim handoffs after attachment commit or owner deletion, never by age.
use super::ProjectionContext;
use crate::gateway::{
    GatewayApplicationError,
    application::{app_error, storage::AppStorageError},
};
use rusqlite::OptionalExtension;
use std::path::PathBuf;

async fn sweep(context: &ProjectionContext) -> Result<(), GatewayApplicationError> {
    let root = context
        .butler_data
        .join(butler_platform::data_paths::MESSAGE_HANDOFFS);
    let entries = tokio::task::spawn_blocking(move || inventory(root))
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
    for page in entries.chunks(64) {
        let page = page.to_vec();
        let obsolete = context
            .storage
            .inspect(move |db| {
                let mut obsolete = Vec::new();
                for (path, turn, session) in page {
                    let state: Option<String> = db
                        .query_row("SELECT state FROM turns WHERE id=?1", [&turn], |row| {
                            row.get(0)
                        })
                        .optional()
                        .map_err(AppStorageError::sqlite)?;
                    let expired = if let Some(session) = session {
                        super::super::sessions::identity::resolve_owner(db, &session)?.is_none()
                    } else {
                        state.is_none() || state.as_deref() == Some("delivered")
                    };
                    if expired {
                        obsolete.push(path);
                    }
                }
                Ok(obsolete)
            })
            .await
            .map_err(app_error)?;
        tokio::task::spawn_blocking(move || {
            for path in obsolete {
                butler_platform::secure_fs::remove_tree(&path)?;
            }
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
    }
    Ok(())
}

fn inventory(root: PathBuf) -> std::io::Result<Vec<(PathBuf, String, Option<String>)>> {
    let mut entries = Vec::new();
    let directories = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(error) => return Err(error),
    };
    for entry in directories {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        match std::fs::read_to_string(path.join(".turn")) {
            Ok(identity) => {
                let (turn, session) =
                    serde_json::from_str(&identity).map_err(std::io::Error::other)?;
                entries.push((path, turn, session));
            }
            // A producer may not have published the identity yet.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(entries)
}

pub(super) async fn materialize(
    context: &ProjectionContext,
    candidate: &mut super::final_candidate::FinalCandidate,
) -> Result<Vec<crate::gateway::MaterializedResponderFile>, GatewayApplicationError> {
    match context
        .dependencies
        .artifact_materializer
        .materialize(candidate.materialization.clone())
        .await
    {
        Ok(files) => Ok(files),
        Err(GatewayApplicationError::Public { ref code, .. })
            if code == "message_file_unavailable" =>
        {
            if !candidate.text.is_empty() {
                candidate.text.push_str("\n\n");
            }
            candidate.text.push_str("Attachment unavailable.");
            candidate.delivery_metadata = Some(
                serde_json::from_value(serde_json::json!({
                    "delivery_state":"delivered_with_limitations",
                    "limitation_codes":["message_file_unavailable"],
                    "limitations":["Attachment unavailable."]
                }))
                .map_err(GatewayApplicationError::internal_from)?,
            );
            Ok(Vec::new())
        }
        Err(error) => Err(error),
    }
}

/// A fixture barrier leaves final transcript projection pending without blocking shutdown.
#[cfg(feature = "e2e-fixtures")]
pub(super) async fn held() -> Result<bool, GatewayApplicationError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_HOLD_POINT").as_deref() == Ok("message_attachment")
        && let Some(release) = std::env::var_os("BUTLER_E2E_HOLD_RELEASE")
    {
        let release = std::path::PathBuf::from(release);
        if !tokio::fs::try_exists(&release)
            .await
            .map_err(GatewayApplicationError::internal_from)?
        {
            tokio::fs::write(release.with_extension("held"), b"held")
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn cleanup(context: &ProjectionContext) {
    if let Err(error) = sweep(context).await {
        eprintln!("[gateway] handoff cleanup failed: {error}");
    }
}
