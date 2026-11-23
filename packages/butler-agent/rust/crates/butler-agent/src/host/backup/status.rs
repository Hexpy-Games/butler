use std::{fs, io, path::Path, sync::PoisonError};

use butler_backup::backup::LocalState;
use butler_platform::data_paths;
use serde_json::{Value, json};

use super::{Error, Inner, Phase, Result, apply::Restored, cloud, error_code, graph_path};

#[derive(Clone)]
pub(super) struct LocalView {
    pub enabled: bool,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    used_bytes: u64,
    quota_bytes: u64,
}

impl From<&LocalState> for LocalView {
    fn from(state: &LocalState) -> Self {
        Self {
            enabled: state.enabled,
            last_success_at: state.last_success_at.clone(),
            last_error: state.last_error.clone(),
            used_bytes: state.usage.used_bytes,
            quota_bytes: state.usage.quota_bytes,
        }
    }
}

/// The service's answer from the last refresh or backup run, kept in memory.
#[derive(Clone)]
pub(super) struct CloudView {
    used_bytes: u64,
    quota_bytes: u64,
    newest: Option<String>,
}

impl From<&cloud::Inventory> for CloudView {
    fn from(inventory: &cloud::Inventory) -> Self {
        Self {
            used_bytes: inventory.used_bytes,
            quota_bytes: inventory.quota_bytes,
            newest: inventory
                .snapshots
                .iter()
                .map(|snapshot| snapshot.created_at.clone())
                .max(),
        }
    }
}

impl Inner {
    pub(super) fn remember_cloud(&self, inventory: &cloud::Inventory) {
        *self
            .cloud_view
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(CloudView::from(inventory));
    }

    /// Answers from local state; only `refresh` asks the Butler service.
    pub(super) async fn status(&self, cloud: &cloud::Session, refresh: bool) -> Result<Value> {
        let mut cloud_error = None;
        if refresh {
            match cloud.inventory().await {
                Ok(inventory) => self.remember_cloud(&inventory),
                Err(failure @ Error::Public { status: 401, .. }) => return Err(failure),
                Err(failure) => cloud_error = Some(error_code(&failure)),
            }
        }
        let local = self.local_view();
        let remote = self
            .cloud_view
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let (used, quota) = remote
            .as_ref()
            .map_or((local.used_bytes, local.quota_bytes), |remote| {
                (remote.used_bytes, remote.quota_bytes)
            });
        let offer = remote
            .filter(|remote| !local.enabled && remote.quota_bytes > 0)
            .and_then(|remote| Some((remote.newest?, remote.used_bytes)));
        let (restore, memory_search_preparing) = self
            .blocking(move |root| {
                let restore = match offer {
                    Some((created_at, size)) if !super::restore::target_has_data(&root)? => {
                        // The manifest opens only with the recovery key; the
                        // stored size stands in for the backup's size.
                        Some(json!({"created_at": created_at, "total_bytes": size}))
                    }
                    _ => None,
                };
                Ok((restore, preparing(&root)?))
            })
            .await?;
        let mut failure = cloud_error.or(local.last_error);
        let (state, done, total) = match self.phase() {
            Phase::Running { done, total } => ("running", done, total),
            Phase::Restoring { done, total } => ("restoring", done, total),
            Phase::RestoreReady => ("restore_ready", 0, 0),
            Phase::Failed(code) => {
                failure = failure.or(Some(code));
                (failure_state(failure.as_deref()), 0, 0)
            }
            Phase::Idle if failure.is_some() => (failure_state(failure.as_deref()), 0, 0),
            Phase::Idle if local.enabled => ("idle", 0, 0),
            Phase::Idle if restore.is_some() => ("restore_available", 0, 0),
            Phase::Idle => ("off", 0, 0),
        };
        Ok(json!({
            "available": quota > 0, "state": state, "last_backup_at": local.last_success_at,
            "used_bytes": used, "quota_bytes": quota, "progress": {"done": done, "total": total},
            "error": failure, "restore": restore, "memory_search_preparing": memory_search_preparing,
        }))
    }
}

fn failure_state(code: Option<&str>) -> &'static str {
    match code {
        Some("paused") => "paused",
        Some("backup_quota_exceeded") => "full",
        _ => "failed",
    }
}

fn preparing(root: &Path) -> Result<bool> {
    let bytes = match fs::read(root.join(data_paths::BACKUP).join("restored.json")) {
        Ok(bytes) => bytes,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(failure) => return Err(Error::internal_from(failure)),
    };
    let restored: Restored = serde_json::from_slice(&bytes).map_err(Error::internal_from)?;
    if let Some(graph) = graph_path(root).map_err(Error::internal_from)? {
        return butler_memory::cognition::vectors_pending_since(&graph, &restored.restored_at)
            .map_err(Error::internal_from);
    }
    Ok(false)
}
