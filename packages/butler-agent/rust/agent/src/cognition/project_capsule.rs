//! DATA-backed project memory capsule refresh.

mod inspect;
mod render;
mod source;
mod types;
mod write;

#[cfg(test)]
#[path = "project_capsule/tests.rs"]
mod tests;

use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) use inspect::ProjectCapsuleInspectReport;
pub(crate) use types::ProjectCapsuleMaintenanceResult;

pub(crate) struct ProjectCapsuleService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl ProjectCapsuleService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
        }
    }

    pub(crate) async fn inspect(
        &self,
        project_id: &str,
    ) -> CognitionResult<ProjectCapsuleInspectReport> {
        let project_id = crate::public_text::trim_js_whitespace(project_id).to_owned();
        if project_id.is_empty() {
            return Err(error("project_capsule_project_id_required"));
        }
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || inspect::read(&data_root, &paths, &project_id))
            .await
            .map_err(|_| error("project_capsule_worker_failed"))?
    }

    pub(crate) async fn refresh(
        &self,
        project_id: &str,
        workspace_path: Option<&str>,
        cancellation: &CancellationToken,
        deadline_at_epoch_ms: i64,
    ) -> CognitionResult<PathBuf> {
        check_active(cancellation, deadline_at_epoch_ms)?;
        let project_id = crate::public_text::trim_js_whitespace(project_id).to_owned();
        if project_id.is_empty() {
            return Err(error("project_capsule_project_id_required"));
        }
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let workspace_path = workspace_path.map(str::to_owned);
        let cancellation_for_prepare = cancellation.clone();
        let (prepared, project_lock) = tokio::task::spawn_blocking(move || {
            let target = source::capsule_path(&paths.memory_root(&data_root), &project_id);
            source::ensure_source_authority(&data_root, &paths, &target)?;
            let project_lock = match write::acquire_project_lock(&data_root, &paths, &project_id) {
                Ok(lock) => lock,
                Err(failure) => {
                    write::record_failure_best_effort(
                        &data_root,
                        &paths,
                        &project_id,
                        "lock",
                        &failure.message,
                    );
                    return Err(failure);
                }
            };
            let prepared = match source::prepare(
                &data_root,
                &paths,
                &project_id,
                workspace_path.as_deref(),
                &cancellation_for_prepare,
                deadline_at_epoch_ms,
            ) {
                Ok(prepared) => prepared,
                Err(failure) => {
                    write::record_failure_best_effort(
                        &data_root,
                        &paths,
                        &project_id,
                        "refresh",
                        &failure.message,
                    );
                    return Err(failure);
                }
            };
            Ok((prepared, project_lock))
        })
        .await
        .map_err(|_| error("project_capsule_worker_failed"))??;

        check_active(cancellation, deadline_at_epoch_ms)?;
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let target = prepared.path.clone();
        tokio::task::spawn_blocking(move || {
            source::ensure_source_authority(&data_root, &paths, &target)
        })
        .await
        .map_err(|_| error("project_capsule_worker_failed"))??;
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        let coordinator = self.coordinator.clone();
        let request = CognitionWriteAcquire {
            lock_path: lock_path.clone(),
            purpose: Some("project_capsule_refresh".to_owned()),
            deadline_at_epoch_ms: Some(deadline_at_epoch_ms as f64),
            cancellation: Some(cancellation.clone()),
        };
        let lease = coordinator
            .acquire(request, CognitionWaitClass::Background)
            .await
            .map_err(CognitionError::from)?
            .ok_or_else(|| unavailable_lease(cancellation, deadline_at_epoch_ms))?;

        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let cancellation = cancellation.clone();
        tokio::task::spawn_blocking(move || {
            let _project_lock = project_lock;
            let result = write::commit(
                &data_root,
                &paths,
                &lock_path,
                &prepared,
                &lease,
                &cancellation,
                deadline_at_epoch_ms,
            );
            let released = lease.release(result.is_ok()).map_err(CognitionError::from);
            match (result, released) {
                (Err(error), _) | (Ok(_), Err(error)) => Err(error),
                (Ok(path), Ok(())) => Ok(path),
            }
        })
        .await
        .map_err(|_| error("project_capsule_worker_failed"))?
    }

    pub(crate) async fn refresh_registered(
        &self,
        max_projects: usize,
        cancellation: &CancellationToken,
        deadline_at_epoch_ms: i64,
    ) -> CognitionResult<ProjectCapsuleMaintenanceResult> {
        check_active(cancellation, deadline_at_epoch_ms)?;
        let data_root = self.data_root.clone();
        let cancellation_for_read = cancellation.clone();
        let projects = tokio::task::spawn_blocking(move || {
            source::read_registry_entries(&data_root, &cancellation_for_read, deadline_at_epoch_ms)
        })
        .await
        .map_err(|_| error("project_capsule_worker_failed"))??
        .into_iter()
        .take(max_projects)
        .collect::<Vec<_>>();
        let mut result = ProjectCapsuleMaintenanceResult {
            considered: projects.len(),
            refreshed: 0,
            failed: Vec::new(),
        };
        for project in projects {
            check_active(cancellation, deadline_at_epoch_ms)?;
            let project_id = project.name.clone();
            let workspace = project.raw.get("path").and_then(serde_json::Value::as_str);
            match self
                .refresh(&project_id, workspace, cancellation, deadline_at_epoch_ms)
                .await
            {
                Ok(_) => result.refreshed += 1,
                Err(_) => result.failed.push(()),
            }
        }
        Ok(result)
    }
}

pub(crate) fn check_active(
    cancellation: &CancellationToken,
    deadline_at_epoch_ms: i64,
) -> CognitionResult<()> {
    if cancellation.is_cancelled() {
        return Err(error("memory_write_aborted"));
    }
    if now_epoch_ms() >= deadline_at_epoch_ms {
        return Err(error("memory_write_timeout"));
    }
    Ok(())
}

fn now_epoch_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128),
    )
    .unwrap_or(i64::MAX)
}

fn unavailable_lease(cancellation: &CancellationToken, deadline: i64) -> CognitionError {
    if cancellation.is_cancelled() {
        error("memory_write_aborted")
    } else if now_epoch_ms() >= deadline {
        error("memory_write_timeout")
    } else {
        error("memory_write_busy")
    }
}

pub(super) fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
