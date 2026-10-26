//! Session Work operations on the existing serialized BtccStorage connection.

mod common;
mod delegated_result;
mod delegation;
pub(in crate::btcc::storage) use delegated_result::settle as settle_steward_parent;
pub(in crate::btcc::storage) use delegation::{
    legacy_parent as legacy_steward_parent, prepare as prepare_steward_work,
};
mod disposition;
mod legacy;
mod monitoring;
mod mutation;
mod observer;
mod read;
mod relation;
mod review;
mod scope_selection;
mod tool_result;

#[cfg(test)]
mod boundary_tests;
#[cfg(test)]
mod disposition_cas_tests;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use rusqlite::{Connection, TransactionBehavior};

use crate::btcc::work::*;
use crate::btcc::{BtccError, PortFuture};

use super::{BtccStorage, StorageError, StorageResult};

pub(in crate::btcc::storage) use disposition::evidence::resolve as resolve_work_evidence;
pub(in crate::btcc::storage) use legacy::project_external_legacy_work;
pub use monitoring::WorkStatusObservation;
pub use observer::SessionPlanObservation;
pub(in crate::btcc::storage) use read::view as hydrate_work_view;
pub use scope_selection::PersistedWorkTurnScope;
pub(in crate::btcc::storage) use tool_result::CONTROL_TOOLS as WORK_CONTROL_TOOLS;

/// The SQLite store of durable Work.
pub struct SessionWorkRepository {
    storage: BtccStorage,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
}

impl SessionWorkRepository {
    /// A repository over the store and clock.
    pub fn new(storage: BtccStorage, clock: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { storage, clock }
    }

    async fn read<T, F>(&self, operation: F) -> Result<T, BtccError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> StorageResult<T> + Send + 'static,
    {
        self.storage
            .execute(move |db| operation(db))
            .await
            .map_err(BtccError::from)
    }

    async fn write<T, F>(&self, operation: F) -> Result<T, BtccError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection, &dyn Fn() -> String) -> StorageResult<T> + Send + 'static,
    {
        let clock = self.clock.clone();
        self.storage
            .execute(move |db| {
                let transaction = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(StorageError::sqlite)?;
                let result = operation(&transaction, &*clock)?;
                transaction.commit().map_err(StorageError::sqlite)?;
                Ok(result)
            })
            .await
            .map_err(BtccError::from)
    }
}

impl DurableWorkRepository for SessionWorkRepository {
    fn work_for_turn(&self, turn: String, work: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move {
            self.read(move |db| {
                let session: String = db
                    .query_row(
                        "SELECT session_id FROM btcc_turns WHERE turn_id=?1",
                        [&turn],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::sqlite)?;
                let Some(row) = common::work(db, &work)? else {
                    return Ok(None);
                };
                if row.session_id != session {
                    return Ok(None);
                }
                read::view(db, &work).map(Some)
            })
            .await
        })
    }
    fn steward_owns_work(&self, session: String, work: String) -> PortFuture<'_, bool> {
        Box::pin(async move {
            self.read(move |db| {
            db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.parent_session_id=?1 AND json_extract(d.packet_json,'$.parent_work_ref.work_id')=?2 AND json_extract(d.packet_json,'$.child_role')='steward' AND NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id))", rusqlite::params![session,work], |row| row.get(0)).map_err(StorageError::sqlite)
        }).await
        })
    }

    fn load_context(&self, scope: WorkTurnScope) -> PortFuture<'_, Option<WorkContext>> {
        Box::pin(async move {
            self.read(move |db| {
                common::session_scope(&scope)?;
                read::load_context(db, &scope)
            })
            .await
        })
    }
    fn import_open_legacy_work(
        &self,
        scope: WorkTurnScope,
    ) -> PortFuture<'_, Option<LegacyImport>> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&scope)?;
                legacy::import(db, &scope, clock)
            })
            .await
        })
    }
    fn bind_open_work(
        &self,
        scope: WorkTurnScope,
        expected_work_id: Option<String>,
    ) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&scope)?;
                relation::bind_open(db, &scope, expected_work_id.as_deref(), clock)
            })
            .await
        })
    }
    fn start_work(&self, command: StartWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&command.input.scope)?;
                relation::start(db, &command, clock)
            })
            .await
        })
    }
    fn continue_work(&self, command: ContinueWorkCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&command.input.scope)?;
                relation::continue_work(db, &command, clock)
            })
            .await
        })
    }
    fn replace_plan(&self, command: ReplacePlanCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&command.input.scope)?;
                mutation::replace_plan(db, &command, clock)
            })
            .await
        })
    }
    fn record_checkpoint(&self, command: CheckpointCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&command.input.scope)?;
                mutation::record_checkpoint(db, &command, clock)
            })
            .await
        })
    }
    fn record_review(&self, command: ReviewCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&command.input.scope)?;
                review::record(db, &command, clock)
            })
            .await
        })
    }
    fn record_disposition(&self, command: DispositionCommand) -> PortFuture<'_, WorkView> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&command.input.scope)?;
                disposition::record(db, &command, clock)
            })
            .await
        })
    }
    fn claim_closeout_correction(
        &self,
        input: ClaimCloseoutCorrectionInput,
    ) -> PortFuture<'_, bool> {
        Box::pin(async move {
            self.write(move |db, clock| {
                common::session_scope(&input.scope)?;
                disposition::claim_correction(db, &input, clock)
            })
            .await
        })
    }
    fn bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move { self.read(move |db| read::bound_view(db, &turn_id)).await })
    }
    fn abandon_bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>> {
        Box::pin(async move {
            self.write(move |db, clock| relation::abandon_bound_turn(db, &turn_id, clock))
                .await
        })
    }
}
