use std::sync::Arc;

use rusqlite::{Connection, params};
use serde_json::Value;

use super::reads::get_by_session_id;
use super::{
    ExecutionContextInput, OwnOptional, RebindWorkspaceInput, RebindWorkspaceResult,
    SessionLifecycleState, UpsertSessionBinding, dedupe_transport_bindings, encode_metadata,
    normalize_thread_id,
};
use crate::workspace::WorkspaceCode;
use crate::workspace::{SessionBindingStore, WorkspaceClock, WorkspaceError, WorkspaceResult};

impl SessionBindingStore {
    pub(crate) async fn upsert(
        &self,
        binding: UpsertSessionBinding,
    ) -> WorkspaceResult<super::StoredSessionBinding> {
        let clock: Arc<dyn WorkspaceClock> = Arc::clone(self.clock());
        self.execute(move |connection| upsert(connection, binding, clock.as_ref()))
            .await
    }

    pub(crate) async fn rebind_workspace(
        &self,
        input: RebindWorkspaceInput,
    ) -> WorkspaceResult<RebindWorkspaceResult> {
        let clock: Arc<dyn WorkspaceClock> = Arc::clone(self.clock());
        self.execute(move |connection| rebind(connection, input, clock.as_ref()))
            .await
    }

    pub(crate) async fn compare_and_set_execution_context(
        &self,
        input: ExecutionContextInput,
    ) -> WorkspaceResult<RebindWorkspaceResult> {
        let clock: Arc<dyn WorkspaceClock> = Arc::clone(self.clock());
        self.execute(move |connection| compare_and_set(connection, input, clock.as_ref()))
            .await
    }

    pub(crate) async fn update_lifecycle_state(
        &self,
        session_id: &str,
        lifecycle_state: SessionLifecycleState,
        at: Option<String>,
    ) -> WorkspaceResult<Option<super::StoredSessionBinding>> {
        let session_id = session_id.to_owned();
        let at = match at {
            Some(at) => at,
            None => now_iso(self.clock().as_ref())?,
        };
        self.execute(move |connection| {
            let last_active = lifecycle_state.is_active().then_some(at.as_str());
            connection
                .execute(
                    "UPDATE session_bindings
                     SET lifecycle_state = ?, updated_at = ?, last_active_at = ?
                     WHERE session_id = ?",
                    params![lifecycle_state.as_str(), at, last_active, session_id],
                )
                .map_err(WorkspaceError::sqlite)?;
            get_by_session_id(connection, &session_id)
        })
        .await
    }

    #[cfg(test)]
    pub(crate) async fn touch_session(
        &self,
        session_id: &str,
        at: Option<String>,
    ) -> WorkspaceResult<Option<super::StoredSessionBinding>> {
        let session_id = session_id.to_owned();
        let at = match at {
            Some(at) => at,
            None => now_iso(self.clock().as_ref())?,
        };
        self.execute(move |connection| {
            connection
                .execute(
                    "UPDATE session_bindings SET updated_at = ?, last_active_at = ?
                     WHERE session_id = ?",
                    params![at, at, session_id],
                )
                .map_err(WorkspaceError::sqlite)?;
            get_by_session_id(connection, &session_id)
        })
        .await
    }

    pub(crate) async fn delete_session(&self, session_id: &str) -> WorkspaceResult<()> {
        let session_id = session_id.to_owned();
        self.execute(move |connection| {
            connection
                .execute(
                    "DELETE FROM session_bindings WHERE session_id = ?",
                    [&session_id],
                )
                .map_err(WorkspaceError::sqlite)?;
            Ok(())
        })
        .await
    }
}

fn upsert(
    connection: &mut Connection,
    binding: UpsertSessionBinding,
    clock: &dyn WorkspaceClock,
) -> WorkspaceResult<super::StoredSessionBinding> {
    let existing = get_by_session_id(connection, &binding.session_id)?;
    let now = match binding.updated_at {
        Some(updated_at) => updated_at,
        None => now_iso(clock)?,
    };
    let lifecycle = binding
        .lifecycle_state
        .or_else(|| existing.as_ref().map(|value| value.lifecycle_state.clone()))
        .unwrap_or(SessionLifecycleState::Active);
    let created_at = binding
        .created_at
        .or_else(|| existing.as_ref().map(|value| value.created_at.clone()))
        .unwrap_or_else(|| now.clone());
    let last_active_at = binding
        .last_active_at
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|value| value.last_active_at.clone())
        })
        .or_else(|| {
            (!matches!(
                lifecycle,
                SessionLifecycleState::Closed | SessionLifecycleState::Crashed
            ))
            .then(|| now.clone())
        });
    let metadata = binding
        .metadata
        .or_else(|| existing.as_ref().and_then(|value| value.metadata.clone()));
    let app_project_id = match binding.app_project_id {
        OwnOptional::Value(value) => Some(value),
        OwnOptional::Null => None,
        OwnOptional::Absent => existing
            .as_ref()
            .and_then(|value| value.app_project_id.clone())
            .or_else(|| binding.project_id.clone()),
    };
    let ledger_project_id = match binding.ledger_project_id {
        OwnOptional::Value(value) => Some(value),
        OwnOptional::Null => None,
        OwnOptional::Absent => existing
            .as_ref()
            .and_then(|value| value.ledger_project_id.clone()),
    };
    let metadata_json = metadata.as_ref().map(encode_metadata).transpose()?;
    let transports = dedupe_transport_bindings(binding.transport_bindings);
    let transaction = connection.transaction().map_err(WorkspaceError::sqlite)?;
    transaction
        .execute(
            "INSERT INTO session_bindings (
               session_id, role, lifecycle_state, project_id, app_project_id,
               ledger_project_id, workspace_path, runtime_adapter_id, model_provider_id,
               model_ref, runtime_session_ref, provider_thread_ref, created_at, updated_at,
               last_active_at, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               role=excluded.role, lifecycle_state=excluded.lifecycle_state,
               project_id=excluded.project_id, app_project_id=excluded.app_project_id,
               ledger_project_id=excluded.ledger_project_id,
               workspace_path=excluded.workspace_path,
               runtime_adapter_id=excluded.runtime_adapter_id,
               model_provider_id=excluded.model_provider_id, model_ref=excluded.model_ref,
               runtime_session_ref=excluded.runtime_session_ref,
               provider_thread_ref=excluded.provider_thread_ref,
               updated_at=excluded.updated_at, last_active_at=excluded.last_active_at,
               metadata_json=excluded.metadata_json",
            params![
                binding.session_id,
                binding.role.as_str(),
                lifecycle.as_str(),
                binding.project_id,
                app_project_id,
                ledger_project_id,
                binding.workspace_path,
                binding.runtime_adapter_id,
                binding.model_provider_id,
                binding.model_ref,
                binding.runtime_session_ref,
                binding.provider_thread_ref,
                created_at,
                now,
                last_active_at,
                metadata_json,
            ],
        )
        .map_err(WorkspaceError::sqlite)?;
    transaction
        .execute(
            "DELETE FROM session_transport_bindings WHERE session_id = ?",
            [&binding.session_id],
        )
        .map_err(WorkspaceError::sqlite)?;
    for item in transports {
        transaction
            .execute(
                "INSERT INTO session_transport_bindings
                 (session_id, transport, account_id, peer_id, thread_id)
                 VALUES (?, ?, ?, ?, ?)",
                params![
                    binding.session_id,
                    item.transport,
                    item.account_id,
                    item.peer_id,
                    normalize_thread_id(item.thread_id.as_deref()),
                ],
            )
            .map_err(WorkspaceError::sqlite)?;
    }
    transaction.commit().map_err(WorkspaceError::sqlite)?;
    get_by_session_id(connection, &binding.session_id)?.ok_or_else(|| {
        WorkspaceError::new(
            WorkspaceCode::WorkspaceUpsertLost,
            "Upserted session binding was not readable",
        )
    })
}

fn rebind(
    connection: &Connection,
    input: RebindWorkspaceInput,
    clock: &dyn WorkspaceClock,
) -> WorkspaceResult<RebindWorkspaceResult> {
    if get_by_session_id(connection, &input.session_id)?.is_none() {
        return Ok(RebindWorkspaceResult::Missing);
    }
    let updated_at = input
        .updated_at
        .filter(|value| value > &input.expected_updated_at)
        .map(Ok)
        .unwrap_or_else(|| next_revision_timestamp(clock, &input.expected_updated_at))?;
    let metadata = encode_metadata(&input.metadata)?;
    let changes = connection
        .execute(
            "UPDATE session_bindings SET workspace_path = ?, metadata_json = ?, updated_at = ?
             WHERE session_id = ? AND updated_at = ?",
            params![
                input.workspace_path,
                metadata,
                updated_at,
                input.session_id,
                input.expected_updated_at
            ],
        )
        .map_err(WorkspaceError::sqlite)?;
    let binding = get_by_session_id(connection, &input.session_id)?;
    if changes != 1 {
        return Ok(RebindWorkspaceResult::Changed(binding));
    }
    Ok(binding
        .map(RebindWorkspaceResult::Applied)
        .unwrap_or(RebindWorkspaceResult::Changed(None)))
}

fn compare_and_set(
    connection: &mut Connection,
    input: ExecutionContextInput,
    clock: &dyn WorkspaceClock,
) -> WorkspaceResult<RebindWorkspaceResult> {
    let transaction = connection.transaction().map_err(WorkspaceError::sqlite)?;
    let Some(current) = get_by_session_id(&transaction, &input.session_id)? else {
        return Ok(RebindWorkspaceResult::Missing);
    };
    let replay = current
        .metadata
        .as_ref()
        .and_then(|value| value.get("relocationId"))
        .and_then(Value::as_str)
        == Some(input.operation_id.as_str());
    if replay {
        let same = current.workspace_path == input.workspace_path
            && current.project_id == input.project_id
            && current.app_project_id == input.app_project_id
            && current.ledger_project_id == input.ledger_project_id;
        return Ok(if same {
            RebindWorkspaceResult::Applied(current)
        } else {
            RebindWorkspaceResult::Changed(Some(current))
        });
    }
    if current.updated_at != input.expected_updated_at {
        return Ok(RebindWorkspaceResult::Changed(Some(current)));
    }
    let updated_at = next_revision_timestamp(clock, &input.expected_updated_at)?;
    let mut metadata = input.metadata;
    metadata.insert("relocationId".into(), input.operation_id.into());
    transaction
        .execute(
            "UPDATE session_bindings SET workspace_path=?, project_id=?, app_project_id=?,
               ledger_project_id=?, metadata_json=?, updated_at=?
             WHERE session_id=? AND updated_at=?",
            params![
                input.workspace_path,
                input.project_id,
                input.app_project_id,
                input.ledger_project_id,
                encode_metadata(&metadata)?,
                updated_at,
                input.session_id,
                input.expected_updated_at,
            ],
        )
        .map_err(WorkspaceError::sqlite)?;
    let binding = get_by_session_id(&transaction, &input.session_id)?.ok_or_else(|| {
        WorkspaceError::new(
            WorkspaceCode::WorkspaceCasLost,
            "Updated session binding was not readable",
        )
    })?;
    transaction.commit().map_err(WorkspaceError::sqlite)?;
    Ok(RebindWorkspaceResult::Applied(binding))
}

fn now_iso(clock: &dyn WorkspaceClock) -> WorkspaceResult<String> {
    clock.iso_from_epoch_millis(clock.now_epoch_millis())
}

fn next_revision_timestamp(clock: &dyn WorkspaceClock, previous: &str) -> WorkspaceResult<String> {
    let now = clock.now_epoch_millis();
    let next = clock
        .parse_iso_millis(previous)
        .and_then(|value| value.checked_add(1))
        .map_or(now, |value| now.max(value));
    clock.iso_from_epoch_millis(next)
}
