//! Reclaim handoffs after attachment commit or owner deletion, never by age.
use super::ProjectionContext;
use crate::gateway::{
    GatewayApplicationError,
    application::{app_error, storage::AppStorageError},
};
use std::path::PathBuf;
mod ownership;
use ownership::Owner;

/// Inventory is loaded once; filesystem notifications refresh only changed owners.
#[derive(Clone, Default)]
pub(super) struct Index(std::collections::HashMap<PathBuf, (Owner, String)>);
impl Index {
    pub(super) async fn load(context: &ProjectionContext) -> Result<Self, GatewayApplicationError> {
        let data = context.butler_data.clone();
        tokio::task::spawn_blocking(move || {
            let root = data.join(butler_platform::data_paths::MESSAGE_HANDOFFS);
            let mut index = Self::default();
            if root.exists() {
                for entry in std::fs::read_dir(root)? {
                    index.refresh(entry?.path())?;
                }
            }
            Ok::<_, std::io::Error>(index)
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)
    }
    fn refresh(&mut self, path: PathBuf) -> std::io::Result<()> {
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
        let owner = ownership::decode(value)?;
        self.0.insert(path, (owner, identity));
        Ok(())
    }
    pub(super) async fn cleanup(
        &mut self,
        context: &ProjectionContext,
        paths: std::collections::HashSet<PathBuf>,
    ) {
        if let Err(error) = self.sweep(context, paths).await {
            eprintln!("[gateway] handoff cleanup failed: {error}");
        }
    }
    async fn sweep(
        &mut self,
        context: &ProjectionContext,
        paths: std::collections::HashSet<PathBuf>,
    ) -> Result<(), GatewayApplicationError> {
        let data = context.butler_data.clone();
        let mut index = self.clone();
        let (index, entries) = tokio::task::spawn_blocking(move || {
            for path in paths {
                index.refresh(path)?;
            }
            let entries = index
                .0
                .iter()
                .map(|(path, (owner, identity))| {
                    Ok((
                        path.clone(),
                        ownership::resolve(&data, owner)?,
                        identity.clone(),
                    ))
                })
                .collect::<std::io::Result<Vec<_>>>()?;
            Ok::<_, std::io::Error>((index, entries))
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)?;
        *self = index;
        let obsolete = context
            .storage
            .inspect(move |db| {
                let mut obsolete = Vec::new();
                for (path, turn, identity) in entries {
                    if ownership::expired(db, turn)? {
                        obsolete.push((path, identity));
                    }
                }
                Ok(obsolete)
            })
            .await
            .map_err(app_error)?;
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

/// Publish the same structured metadata used by retained message projections immediately.
pub(super) fn record_delivery(
    db: &rusqlite::Connection,
    candidate: &super::final_candidate::FinalCandidate,
    now: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, AppStorageError> {
    let mut payload =
        serde_json::Map::from_iter([("safeLabel".into(), serde_json::json!("Completed"))]);
    if let Some(delivery) = &candidate.delivery_metadata {
        db.execute("INSERT INTO app_terminal_turn_projections(turn_id,chat_id,terminal_state,progress_rows_json,delivery_metadata_json,source_event_high_water,compacted_at) VALUES(?1,?2,'delivered','[]',?3,0,?4) ON CONFLICT(turn_id) DO UPDATE SET delivery_metadata_json=excluded.delivery_metadata_json",
            rusqlite::params![candidate.turn_id,candidate.chat_id,serde_json::Value::Object(delivery.clone()).to_string(),now]).map_err(AppStorageError::sqlite)?;
        payload.extend(delivery.clone());
    }
    Ok(payload)
}
