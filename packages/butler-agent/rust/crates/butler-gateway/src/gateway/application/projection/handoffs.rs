//! Reclaim handoffs after attachment commit or owner deletion, never by age.
use super::ProjectionContext;
use crate::gateway::{
    GatewayApplicationError,
    application::{app_error, storage::AppStorageError},
};
use rusqlite::OptionalExtension;
use std::path::PathBuf;

/// Inventory is loaded once; filesystem notifications refresh only changed owners.
#[derive(Clone, Default)]
pub(super) struct Index(std::collections::HashMap<PathBuf, (String, String)>);
impl Index {
    pub(super) async fn load(context: &ProjectionContext) -> Result<Self, GatewayApplicationError> {
        let data = context.butler_data.clone();
        tokio::task::spawn_blocking(move || {
            let root = data.join(butler_platform::data_paths::MESSAGE_HANDOFFS);
            let mut index = Self::default();
            if root.exists() {
                for entry in std::fs::read_dir(root)? {
                    index.refresh(&data, entry?.path())?;
                }
            }
            Ok::<_, std::io::Error>(index)
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)
    }
    fn refresh(&mut self, data: &std::path::Path, path: PathBuf) -> std::io::Result<()> {
        self.0.remove(&path);
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".handoff."))
        {
            return Ok(());
        }
        let identity = match std::fs::read_to_string(path.join(".turn")) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let value: serde_json::Value =
            serde_json::from_str(&identity).map_err(std::io::Error::other)?;
        let turn = if let Some(turn) = value.get("turn").and_then(|v| v.as_str()) {
            value
                .get("parent_turn")
                .and_then(|v| v.as_str())
                .unwrap_or(turn)
                .to_owned()
        } else {
            let (turn, session): (String, Option<String>) =
                serde_json::from_value(value).map_err(std::io::Error::other)?;
            if session.is_some() {
                legacy_owner(data, &turn)?.unwrap_or(turn)
            } else {
                turn
            }
        };
        self.0.insert(path, (turn, identity));
        Ok(())
    }
    pub(super) async fn cleanup(
        &mut self,
        context: &ProjectionContext,
        paths: std::collections::HashSet<PathBuf>,
    ) -> Result<(), GatewayApplicationError> {
        let data = context.butler_data.clone();
        let mut index = self.clone();
        *self = tokio::task::spawn_blocking(move || {
            for path in paths {
                index.refresh(&data, path)?;
            }
            Ok::<_, std::io::Error>(index)
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
        let entries: Vec<_> = self
            .0
            .iter()
            .map(|(path, (turn, identity))| (path.clone(), turn.clone(), identity.clone()))
            .collect();
        let obsolete = context.storage.inspect(move |db| {
            let mut obsolete = Vec::new();
            for (path, turn, identity) in entries {
                let resumable: Option<bool> = db.query_row(
                    "SELECT state NOT IN ('delivered','failed','cancelled') AND (state<>'runtime_fault' OR retryable<>0) FROM turns WHERE id=?1",
                    [&turn], |row| row.get(0)).optional().map_err(AppStorageError::sqlite)?;
                if resumable != Some(true) { obsolete.push((path, identity)); }
            }
            Ok(obsolete)
        }).await.map_err(app_error)?;
        let removed = tokio::task::spawn_blocking(move || {
            let mut removed = Vec::new();
            for (path, identity) in obsolete {
                if butler_platform::secure_fs::reclaim_handoff(&path, &identity)? {
                    removed.push(path);
                }
            }
            Ok::<_, std::io::Error>(removed)
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
        for path in removed {
            self.0.remove(&path);
        }
        Ok(())
    }
}

// Resolve pre-upgrade worker records through indexed delegation ownership.
fn legacy_owner(data: &std::path::Path, turn: &str) -> std::io::Result<Option<String>> {
    let path = data.join(butler_platform::data_paths::BTCC_DB);
    if !path.exists() {
        return Ok(None);
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(std::io::Error::other)?;
    let mut owner = turn.to_owned();
    let mut seen = std::collections::HashSet::new();
    while seen.insert(owner.clone()) {
        let parent: Option<String> = db.query_row(
            "SELECT r.parent_turn_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.child_turn_id=?1",
            [&owner], |row| row.get(0)).optional().map_err(std::io::Error::other)?;
        match parent {
            Some(parent) => owner = parent,
            None => return Ok(Some(owner)),
        }
    }
    Err(std::io::Error::other("invalid_handoff_owner"))
}

pub(super) async fn materialize(
    context: &ProjectionContext,
    candidate: &mut super::final_candidate::FinalCandidate,
) -> Result<Vec<crate::gateway::MaterializedResponderFile>, GatewayApplicationError> {
    let result = context
        .dependencies
        .artifact_materializer
        .materialize_with_limitations(candidate.materialization.clone())
        .await?;
    if result.unavailable {
        let metadata = candidate
            .delivery_metadata
            .get_or_insert_with(Default::default);
        metadata.insert(
            "delivery_state".into(),
            serde_json::json!("delivered_with_limitations"),
        );
        let codes = metadata
            .entry("limitation_codes".to_owned())
            .or_insert_with(|| serde_json::json!([]));
        if let Some(codes) = codes.as_array_mut()
            && !codes.iter().any(|code| code == "message_file_unavailable")
        {
            codes.push(serde_json::json!("message_file_unavailable"));
        }
    }
    Ok(result.files)
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
