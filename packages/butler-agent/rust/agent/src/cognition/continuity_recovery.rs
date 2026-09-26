//! Source-compatible, manifest-backed operator recovery of completed turns.

mod candidates;
pub(in crate::cognition) mod hot_cache;
mod manifest;
mod workspace;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Serialize;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

use self::manifest::{
    ContinuityRecoveryManifest, RecoveryAfter, RecoveryCandidate, RecoveryQuarantine,
};

const SCHEMA: &str = "butler.continuity-recovery-manifest.v1";

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ContinuityRecoveryManifestView {
    pub manifest_id: String,
    pub project_id: String,
    pub status: String,
    pub inventory_by_project: std::collections::BTreeMap<String, usize>,
    pub candidate_count: usize,
    pub approved_count: usize,
    pub quarantine_count: usize,
    pub before: RecoveryBeforeView,
    pub after: Option<RecoveryAfter>,
    pub candidates: Vec<RecoveryCandidateView>,
    pub quarantine: Vec<RecoveryQuarantine>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecoveryBeforeView {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecoveryCandidateView {
    pub candidate_id: String,
    pub project_id: String,
    pub conversation_session_id: String,
    pub conversation_turn_id: String,
    pub inbound_message_id: String,
    pub outbound_message_id: String,
    pub completed_at: String,
    pub preview: String,
    pub body_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ContinuityRecoveryAction {
    pub manifest: ContinuityRecoveryManifestView,
    pub replayed: bool,
}

pub(crate) struct ContinuityRecoveryService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl ContinuityRecoveryService {
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

    pub(crate) async fn plan(
        &self,
        project_id: &str,
        workspace: &Path,
    ) -> CognitionResult<ContinuityRecoveryManifestView> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let project_id = project_id.to_owned();
        let workspace = workspace.to_owned();
        tokio::task::spawn_blocking(move || {
            let manifest = candidates::plan(&data_root, &paths, &project_id, &workspace)?;
            view(manifest)
        })
        .await
        .map_err(|_| error("continuity_recovery_worker_failed"))?
    }

    pub(crate) async fn inspect(
        &self,
        manifest_id: &str,
    ) -> CognitionResult<Option<ContinuityRecoveryManifestView>> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let manifest_id = manifest_id.to_owned();
        tokio::task::spawn_blocking(move || {
            manifest::read(&data_root, &paths, &manifest_id)?
                .map(view)
                .transpose()
        })
        .await
        .map_err(|_| error("continuity_recovery_worker_failed"))?
    }

    pub(crate) async fn approve(
        &self,
        manifest_id: &str,
        candidate_ids: Option<Vec<String>>,
    ) -> CognitionResult<ContinuityRecoveryManifestView> {
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock_path.clone(), "continuity-recovery"),
                CognitionWaitClass::Interactive,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let manifest_id = manifest_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let result = (|| {
                lease
                    .assert_for_path(&lock_path)
                    .map_err(|_| error("memory_write_busy"))?;
                let current = manifest::required(&data_root, &paths, &manifest_id)?;
                let updated = manifest::approve(&data_root, &paths, current, candidate_ids)?;
                view(updated)
            })();
            let released = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, released) {
                (Err(failure), _) | (Ok(_), Err(failure)) => Err(failure),
                (Ok(view), Ok(())) => Ok(view),
            }
        })
        .await
        .map_err(|_| error("continuity_recovery_worker_failed"))?
    }

    pub(crate) async fn apply(
        &self,
        manifest_id: &str,
        workspace: &Path,
    ) -> CognitionResult<ContinuityRecoveryAction> {
        self.mutate(manifest_id, workspace, false).await
    }

    pub(crate) async fn rollback(
        &self,
        manifest_id: &str,
        workspace: &Path,
    ) -> CognitionResult<ContinuityRecoveryAction> {
        self.mutate(manifest_id, workspace, true).await
    }

    async fn mutate(
        &self,
        manifest_id: &str,
        workspace: &Path,
        rollback: bool,
    ) -> CognitionResult<ContinuityRecoveryAction> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let manifest_id = manifest_id.to_owned();
        let workspace = workspace.to_owned();
        let is_replayed = tokio::task::spawn_blocking({
            let data_root = data_root.clone();
            let paths = paths.clone();
            let manifest_id = manifest_id.clone();
            let workspace = workspace.clone();
            move || hot_cache::replay_result(&data_root, &paths, &manifest_id, &workspace, rollback)
        })
        .await
        .map_err(|_| error("continuity_recovery_worker_failed"))??;
        if let Some(action) = is_replayed {
            return Ok(action);
        }

        let lock_path = self.paths.consolidation_lock(&self.data_root);
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock_path.clone(), "continuity-recovery"),
                CognitionWaitClass::Interactive,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        tokio::task::spawn_blocking(move || {
            let result = if rollback {
                hot_cache::rollback(
                    &data_root,
                    &paths,
                    &manifest_id,
                    &workspace,
                    &lock_path,
                    &lease,
                )
            } else {
                hot_cache::apply(
                    &data_root,
                    &paths,
                    &manifest_id,
                    &workspace,
                    &lock_path,
                    &lease,
                )
            };
            let released = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, released) {
                (Err(failure), _) | (Ok(_), Err(failure)) => Err(failure),
                (Ok(action), Ok(())) => Ok(action),
            }
        })
        .await
        .map_err(|_| error("continuity_recovery_worker_failed"))?
    }
}

fn view(manifest: ContinuityRecoveryManifest) -> CognitionResult<ContinuityRecoveryManifestView> {
    let before = RecoveryBeforeView {
        path: manifest.before.path.clone(),
        bytes: manifest.before.bytes,
        sha256: manifest.before.sha256.clone(),
    };
    let candidates = manifest
        .candidates
        .iter()
        .map(|candidate: &RecoveryCandidate| RecoveryCandidateView {
            candidate_id: candidate.candidate_id.clone(),
            project_id: candidate.project_id.clone(),
            conversation_session_id: candidate.conversation_session_id.clone(),
            conversation_turn_id: candidate.conversation_turn_id.clone(),
            inbound_message_id: candidate.inbound_message_id.clone(),
            outbound_message_id: candidate.outbound_message_id.clone(),
            completed_at: candidate.completed_at.clone(),
            preview: candidate.preview.clone(),
            body_sha256: candidate.body_sha256.clone(),
        })
        .collect::<Vec<_>>();
    Ok(ContinuityRecoveryManifestView {
        manifest_id: manifest.manifest_id,
        project_id: manifest.project_id,
        status: manifest.status,
        inventory_by_project: manifest.inventory_by_project,
        candidate_count: candidates.len(),
        approved_count: manifest.approved_candidate_ids.len(),
        quarantine_count: manifest.quarantine.len(),
        before,
        after: manifest.after,
        candidates,
        quarantine: manifest.quarantine,
    })
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
