use parking_lot::Mutex as StdMutex;
use std::{
    collections::HashMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use tokio::sync::Mutex;

use super::commands::{self, SpaceHistory};
use super::contracts::{AppSpaceCommand, AppSpaceMutationResult, AppSpaceOrigin};
use super::relocation::AppRelocationDestination;
use crate::gateway::application::{
    EventSubscribers, events,
    storage::{AppStorage, AppStorageError},
};
use crate::gateway::{GatewayApplicationError, application::AppIdentityClock};

pub(in crate::gateway::application) struct SpaceMutationOwner {
    closed: AtomicBool,
    state: Mutex<SpaceHistory>,
    relocation_locks: StdMutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl SpaceMutationOwner {
    pub(in crate::gateway::application) fn new() -> Self {
        Self {
            closed: AtomicBool::new(false),
            state: Mutex::new(SpaceHistory::default()),
            relocation_locks: StdMutex::new(HashMap::new()),
        }
    }

    pub(in crate::gateway::application) async fn lock_relocation(
        &self,
        session_id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, GatewayApplicationError> {
        let lock = {
            let mut locks = self.relocation_locks.lock();
            if self.closed.load(Ordering::Acquire) {
                return Err(GatewayApplicationError::Internal);
            }
            let lock = locks
                .get(session_id)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(Mutex::new(())));
            locks.insert(session_id.to_owned(), Arc::downgrade(&lock));
            lock
        };
        let guard = lock.lock_owned().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(GatewayApplicationError::Internal);
        }
        Ok(guard)
    }

    pub(super) async fn read(
        &self,
        storage: &AppStorage,
    ) -> Result<Value, GatewayApplicationError> {
        let state = self.state.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(GatewayApplicationError::Internal);
        }
        let mut view = storage
            .execute(|db| super::reader::read(db))
            .await
            .map_err(super::super::app_error)?;
        if let (Some(undo), Some(notice)) = (&state.undo, &state.smart_notice)
            && undo.revision == view.revision
            && notice.revision == view.revision
        {
            view.smart_notice = Some(notice.clone());
        }
        serde_json::to_value(view).map_err(|_| GatewayApplicationError::Internal)
    }

    pub(super) async fn execute(
        &self,
        storage: &AppStorage,
        subscribers: &EventSubscribers,
        clock: std::sync::Arc<dyn AppIdentityClock>,
        command: AppSpaceCommand,
        origin: AppSpaceOrigin,
        title: Option<String>,
    ) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        let mut state = self.state.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(GatewayApplicationError::Internal);
        }
        let previous = state.clone();
        let publish_to = subscribers.clone();
        let result = storage
            .execute(move |db| {
                Ok(commands::execute(
                    db,
                    clock.as_ref(),
                    previous,
                    command,
                    origin,
                    title.as_deref().unwrap_or("새 그룹"),
                ))
            })
            .await
            .map_err(super::super::app_error)??;
        *state = result.history;
        drop(state);
        crate::gateway::application::events::publish(&publish_to, result.event);
        Ok(result.result)
    }

    pub(in crate::gateway::application) async fn commit_relocation(
        &self,
        storage: &AppStorage,
        subscribers: &EventSubscribers,
        clock: std::sync::Arc<dyn AppIdentityClock>,
        operation_id: String,
        session_id: String,
        destination: AppRelocationDestination,
    ) -> Result<AppSpaceMutationResult, GatewayApplicationError> {
        let mut history = self.state.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(GatewayApplicationError::Internal);
        }
        let publish_to = subscribers.clone();
        let result = storage
            .execute(move |db| {
                Ok(commit_relocation(
                    db,
                    &operation_id,
                    &session_id,
                    &destination,
                    clock.as_ref(),
                ))
            })
            .await
            .map_err(super::super::app_error)??;
        *history = SpaceHistory::default();
        drop(history);
        for event in result.events {
            events::publish(&publish_to, event);
        }
        Ok(result.result)
    }

    pub(in crate::gateway::application) async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let locks = self
            .relocation_locks
            .lock()
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for lock in locks {
            drop(lock.lock_owned().await);
        }
        drop(self.state.lock().await);
    }
}

struct RelocationCommit {
    result: AppSpaceMutationResult,
    events: Vec<crate::gateway::AppEventEnvelope>,
}

fn commit_relocation(
    db: &mut Connection,
    operation_id: &str,
    session_id: &str,
    destination: &AppRelocationDestination,
    clock: &dyn AppIdentityClock,
) -> Result<RelocationCommit, GatewayApplicationError> {
    let tx = db
        .transaction()
        .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    let changed = tx
        .execute(
            "UPDATE app_session_relocations SET phase='committed' WHERE operation_id=?1 AND session_id=?2 AND phase IN ('preparing','prepared','bound')",
            params![operation_id, session_id],
        )
        .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    if changed == 0 {
        let existing: Option<String> = tx
            .query_row(
                "SELECT phase FROM app_session_relocations WHERE operation_id=?1 AND session_id=?2",
                params![operation_id, session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
        if existing.as_deref() == Some("committed") {
            let view = super::reader::read(&tx).map_err(super::super::app_error)?;
            tx.commit()
                .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
            return Ok(RelocationCommit {
                result: AppSpaceMutationResult {
                    space: view,
                    undo_token: None,
                    group_id: None,
                },
                events: Vec::new(),
            });
        }
        return Err(GatewayApplicationError::Internal);
    }
    let project_id = destination
        .project
        .as_ref()
        .map(|project| project.id.as_str());
    tx.execute(
        "UPDATE chats SET kind=?1,project_id=?2,updated_at=?3 WHERE id=?4",
        params![
            if project_id.is_some() {
                "project"
            } else {
                "chat"
            },
            project_id,
            clock.now_iso(),
            session_id
        ],
    )
    .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    let view = super::reader::read(&tx).map_err(super::super::app_error)?;
    let changed_nodes = super::tree::move_nodes(
        &view,
        &format!("s:{session_id}"),
        destination.target_key.as_deref(),
        destination.position,
        false,
    )?;
    super::commands::save_nodes(&tx, &changed_nodes)?;
    tx.execute(
        "DELETE FROM app_session_context_gate WHERE session_id=?1 AND owner_kind='relocate' AND owner_id=?2",
        params![session_id, operation_id],
    )
    .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    let session =
        crate::gateway::application::sessions::read_summary(&tx, session_id).map_err(app_error)?;
    let updated = events::append_unpublished(
        &tx,
        "session.updated",
        None,
        crate::json::json_object!({"session":session,"context_revision":operation_id}),
        &clock.now_iso(),
    )
    .map_err(app_error)?;
    let final_view = super::reader::read(&tx).map_err(super::super::app_error)?;
    let changed = events::append_unpublished(
        &tx,
        "space.changed",
        None,
        crate::json::json_object!({"revision":final_view.revision}),
        &clock.now_iso(),
    )
    .map_err(app_error)?;
    tx.commit()
        .map_err(|error| app_error(AppStorageError::sqlite(error)))?;
    Ok(RelocationCommit {
        result: AppSpaceMutationResult {
            space: final_view,
            undo_token: None,
            group_id: None,
        },
        events: vec![updated, changed],
    })
}

fn app_error(error: AppStorageError) -> GatewayApplicationError {
    super::super::app_error(error)
}
