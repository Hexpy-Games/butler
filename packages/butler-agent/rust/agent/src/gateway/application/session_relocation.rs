//! App-owned reservation and orchestration for cross-project session relocation.

mod records;
mod recovery;
mod seed;

use serde_json::{Map, Value};

use super::{
    AppApplication, AppRelocateSessionRequest, AppRelocationBindingUpdate,
    AppRelocationCanonicalUpdate, AppRelocationWorkspaceRequest, AppSpaceMutationResult, app_error,
};
use crate::gateway::{GatewayApplicationError, app_session_hint, application::space};

impl AppApplication {
    pub(crate) async fn relocate_session_owned(
        &self,
        request: AppRelocateSessionRequest,
    ) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        let _guard = self
            .space_mutations
            .lock_relocation(&request.session_id)
            .await?;
        let op_id = request.operation_id.clone();
        let existing = self
            .storage
            .execute(move |db| Ok(records::read_row(db, &op_id)))
            .await
            .map_err(app_error)??;
        if let Some(row) = existing {
            let destination = records::decode_destination(&row)?;
            if row.session_id != request.session_id
                || destination.target_key != request.target_key
                || destination.position != request.position
            {
                return Err(public(
                    "relocation_identity_conflict",
                    "이동 요청의 내용이 달라졌습니다.",
                ));
            }
            recovery::recover_one(self, row.clone(), false).await?;
            let phase = self
                .storage
                .execute({
                    let operation_id = request.operation_id.clone();
                    move |db| Ok(records::read_row(db, &operation_id))
                })
                .await
                .map_err(app_error)??
                .map(|row| row.phase);
            return match phase.as_deref() {
                Some("committed") => self.read_space_result().await,
                Some("aborted") => Err(public(
                    "relocation_aborted",
                    "이동이 완료되지 않았습니다. 이동 상태를 다시 확인해 주세요.",
                )),
                _ => Err(public("session_relocating", "대화를 이동하고 있습니다.")),
            };
        }

        let request_for_validation = request.clone();
        self.storage
            .execute(move |db| Ok(records::validate(db, &request_for_validation)))
            .await
            .map_err(app_error)??;
        let runtime_session_id = app_session_hint(&request.session_id);
        let snapshot = self
            .dependencies
            .relocation_host
            .inspect(runtime_session_id)
            .await?;
        let row = self
            .storage
            .execute({
                let request = request.clone();
                move |db| Ok(records::reserve(db, &request, &snapshot))
            })
            .await
            .map_err(app_error)??;
        match self.perform_relocation(row.clone()).await {
            Ok(result) => Ok(result),
            Err(error) => self.fail_relocation(&row, error).await,
        }
    }

    pub(crate) async fn recover_session_relocation_owned(
        &self,
    ) -> Result<(), GatewayApplicationError> {
        let pending = self
            .storage
            .execute(|db| Ok(records::pending(db)))
            .await
            .map_err(app_error)??;
        for row in pending {
            let _guard = match self.space_mutations.lock_relocation(&row.session_id).await {
                Ok(guard) => guard,
                Err(_) => return Ok(()),
            };
            if let Err(error) = recovery::recover_one(self, row.clone(), true).await {
                let operation_id = row.operation_id;
                let _ = self
                    .storage
                    .execute(move |db| Ok(records::mark_conflict(db, &operation_id)))
                    .await;
                let _ = error;
            }
        }
        Ok(())
    }

    async fn perform_relocation(
        &self,
        row: records::Row,
    ) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        let before = records::decode_before(&row)?;
        let destination = records::decode_destination(&row)?;
        let runtime_session_id = app_session_hint(&row.session_id);
        let binding = match before.binding.clone() {
            Some(binding) => binding,
            None => {
                let seed = self.binding_seed(&row.session_id).await?;
                let binding = self
                    .dependencies
                    .relocation_host
                    .ensure_binding(seed)
                    .await?;
                self.storage
                    .execute({
                        let operation_id = row.operation_id.clone();
                        let binding = binding.clone();
                        move |db| Ok(records::store_binding(db, &operation_id, binding))
                    })
                    .await
                    .map_err(app_error)??;
                binding
            }
        };
        let plan = self
            .dependencies
            .relocation_host
            .plan_workspace(AppRelocationWorkspaceRequest {
                runtime_session_id: runtime_session_id.clone(),
                operation_id: row.operation_id.clone(),
                project_path: destination
                    .project
                    .as_ref()
                    .map(|project| project.workspace_path.clone()),
                project_name: destination
                    .project
                    .as_ref()
                    .map(|project| project.display_name.clone()),
            })
            .await?;
        if plan.operation_id != row.operation_id {
            return Err(GatewayApplicationError::Internal);
        }
        self.storage
            .execute({
                let operation_id = row.operation_id.clone();
                let plan = plan.clone();
                move |db| Ok(records::store_plan(db, &operation_id, &plan))
            })
            .await
            .map_err(app_error)??;
        let prepared = self
            .dependencies
            .relocation_host
            .prepare_workspace(plan.clone())
            .await?;
        if prepared.operation_id != plan.operation_id
            || prepared.runtime_session_id != plan.runtime_session_id
            || prepared.workspace_path != plan.workspace_path
            || prepared.marker != plan.marker
            || prepared.created != plan.created
        {
            return Err(GatewayApplicationError::Internal);
        }
        let prepared_for_storage = prepared.clone();
        self.storage
            .execute({
                let operation_id = row.operation_id.clone();
                move |db| {
                    Ok(
                        records::store_plan(db, &operation_id, &prepared_for_storage)
                            .and_then(|()| records::set_phase(db, &operation_id, "prepared")),
                    )
                }
            })
            .await
            .map_err(app_error)??;

        let mut metadata = binding.metadata.unwrap_or_else(Map::new);
        match prepared.marker.as_ref() {
            Some(marker) => {
                metadata.insert(
                    "sessionWorkspace".into(),
                    serde_json::to_value(marker).map_err(|_| GatewayApplicationError::Internal)?,
                );
            }
            None => {
                metadata.remove("sessionWorkspace");
            }
        }
        metadata.insert(
            "appSessionKind".into(),
            Value::String(
                if destination.project.is_some() {
                    "project"
                } else {
                    "chat"
                }
                .into(),
            ),
        );
        metadata.insert(
            "contextRevision".into(),
            Value::String(row.operation_id.clone()),
        );
        let cas = self
            .dependencies
            .relocation_host
            .compare_and_set_binding(AppRelocationBindingUpdate {
                runtime_session_id: runtime_session_id.clone(),
                expected_updated_at: binding.updated_at,
                operation_id: row.operation_id.clone(),
                workspace_path: prepared.workspace_path.clone(),
                project_id: destination
                    .project
                    .as_ref()
                    .map(|project| project.id.clone()),
                app_project_id: destination
                    .project
                    .as_ref()
                    .map(|project| project.id.clone()),
                ledger_project_id: destination
                    .project
                    .as_ref()
                    .and_then(|project| project.ledger_project_id.clone()),
                metadata,
            })
            .await?;
        if !matches!(cas, super::AppRelocationBindingResult::Applied) {
            return Err(public(
                "session_context_changed",
                "대화의 실행 환경이 변경되어 이동하지 못했습니다.",
            ));
        }
        self.storage
            .execute({
                let operation_id = row.operation_id.clone();
                move |db| Ok(records::set_phase(db, &operation_id, "bound"))
            })
            .await
            .map_err(app_error)??;
        self.dependencies
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
        self.space_mutations
            .commit_relocation(
                &self.storage,
                &self.subscribers,
                self.dependencies.identity_clock.clone(),
                row.operation_id,
                row.session_id,
                destination,
            )
            .await
    }

    async fn read_space_result(&self) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        let view = self
            .storage
            .execute(|db| space::read_view(db))
            .await
            .map_err(app_error)?;
        Ok(AppSpaceMutationResult {
            space: view,
            undo_token: None,
            group_id: None,
        })
    }

    async fn fail_relocation(
        &self,
        row: &records::Row,
        error: GatewayApplicationError,
    ) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        let runtime_session_id = app_session_hint(&row.session_id);
        let snapshot = match self
            .dependencies
            .relocation_host
            .inspect(runtime_session_id)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(_) => return Err(error),
        };
        if snapshot
            .binding
            .as_ref()
            .and_then(|binding| binding.metadata.as_ref())
            .and_then(|metadata| metadata.get("relocationId"))
            .and_then(Value::as_str)
            == Some(row.operation_id.as_str())
        {
            return Err(error);
        }
        let operation_id = row.operation_id.clone();
        let current = self
            .storage
            .execute(move |db| Ok(records::read_row(db, &operation_id)))
            .await
            .map_err(app_error)??
            .ok_or(GatewayApplicationError::Internal)?;
        self.storage
            .execute({
                let current = current.clone();
                move |db| Ok(records::abort(db, &current, "relocation_not_applied"))
            })
            .await
            .map_err(app_error)??;
        if let Some(encoded) = current.prepared_json.as_deref()
            && let Ok(plan) = serde_json::from_str(encoded)
        {
            let removed = self
                .dependencies
                .relocation_host
                .discard_workspace(plan)
                .await
                .unwrap_or(false);
            if removed {
                let operation_id = current.operation_id.clone();
                let _ = self
                    .storage
                    .execute(move |db| Ok(records::clear_plan(db, &operation_id)))
                    .await;
            }
        }
        Err(error)
    }
}

fn public(code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
