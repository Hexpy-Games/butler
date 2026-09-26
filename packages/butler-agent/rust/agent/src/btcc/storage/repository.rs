use crate::btcc::ProgressDestination;
use crate::btcc::continuation_budget::TurnContinuationBudgetLimits;
use crate::btcc::turn::{
    CanonicalMessageStore, ContinuationBudgetTransition, HostDependencies,
    ModelRoundAcceptanceWrite, ModelRoundKey, ModelRouteEventWrite, PortFuture, PreparedTurn,
    ProgressEventRepository, ProgressWrite, StateExecutionClaim, StopPersistenceOutcome,
    StorageReadiness, TransitionCommitError, TurnRecord, TurnStore, TurnTransition,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::common::btcc_error;
use super::operation_input::{CanonicalDelivery, TurnVersion};
use super::{
    BtccStorage, StorageError, admission, budget, canonical, claims, hydration, model, progress,
    readiness, stop, transitions,
};

#[derive(Clone)]
pub(crate) struct BtccRepositories {
    pub(super) storage: BtccStorage,
    pub(super) continuation_limits: Option<TurnContinuationBudgetLimits>,
}

impl TurnStore for BtccRepositories {
    fn load_or_admit(&self, prepared: &PreparedTurn) -> PortFuture<'_, (TurnRecord, bool)> {
        let command = prepared.command.clone();
        let admission_input_hash = prepared.admission_input_hash.clone();
        let storage = self.storage.clone();
        let limits = self.continuation_limits.clone();
        Box::pin(async move {
            admission::load_or_admit(&storage, command, admission_input_hash, limits)
                .await
                .map_err(btcc_error)
        })
    }
    fn find_turn(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>> {
        let storage = self.storage.clone();
        let id = turn_id.to_owned();
        Box::pin(async move {
            storage
                .execute(move |db| hydration::find_turn(db, &id))
                .await
                .map_err(btcc_error)
        })
    }
    fn resume_authority(&self, turn_id: &str) -> PortFuture<'_, Option<TurnRecord>> {
        let storage = self.storage.clone();
        let id = turn_id.to_owned();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    transitions::resume_authority(db, &id)?;
                    hydration::find_turn(db, &id)
                })
                .await
                .map_err(btcc_error)
        })
    }
    fn acquire_state_claim(&self, turn: &TurnRecord) -> PortFuture<'_, StateExecutionClaim> {
        let storage = self.storage.clone();
        let turn = TurnVersion::from(turn);
        Box::pin(async move {
            storage
                .execute_with_owner(move |db, owner| claims::acquire(db, owner, &turn))
                .await
                .map_err(btcc_error)
        })
    }
    fn commit_transition(
        &self,
        turn: &TurnRecord,
        claim: &StateExecutionClaim,
        transition: &TurnTransition,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), TransitionCommitError>> + Send + '_>,
    > {
        let storage = self.storage.clone();
        let turn = TurnVersion::from(turn);
        let claim = claim.clone();
        let transition = transition.clone();
        Box::pin(async move {
            storage
                .execute(move |db| transitions::commit(db, &turn, &claim, &transition))
                .await
                .map_err(|error| {
                    if error.code == "transition_contention" {
                        TransitionCommitError::Contention
                    } else {
                        TransitionCommitError::Failure(btcc_error(error))
                    }
                })
        })
    }
    fn activate_successor(&self, turn_id: &str) -> PortFuture<'_, TurnRecord> {
        let storage = self.storage.clone();
        let id = turn_id.to_owned();
        Box::pin(async move {
            storage
                .execute(move |db| {
                    hydration::find_turn(db, &id)?
                        .ok_or_else(|| super::common::error("turn_missing", "BTCC Turn is missing"))
                })
                .await
                .map_err(btcc_error)
        })
    }
    fn stop(&self, turn_id: &str) -> PortFuture<'_, StopPersistenceOutcome> {
        let storage = self.storage.clone();
        let id = turn_id.to_owned();
        Box::pin(async move {
            storage
                .execute(move |db| stop::stop(db, &id))
                .await
                .map_err(btcc_error)
        })
    }
    fn record_model_route_event(
        &self,
        write: ModelRouteEventWrite,
    ) -> PortFuture<'_, Option<Value>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| model::record_event(db, &write))
                .await
                .map_err(btcc_error)
        })
    }
    fn load_model_route_attempt_history(&self, key: ModelRoundKey) -> PortFuture<'_, Value> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| model::load_history(db, &key))
                .await
                .map_err(btcc_error)
        })
    }
    fn load_model_round_acceptance(&self, key: ModelRoundKey) -> PortFuture<'_, Option<Value>> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| model::load_acceptance(db, &key))
                .await
                .map_err(btcc_error)
        })
    }
    fn record_model_round_acceptance(
        &self,
        write: ModelRoundAcceptanceWrite,
    ) -> PortFuture<'_, ()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| model::record_acceptance(db, &write))
                .await
                .map_err(btcc_error)
        })
    }
    fn transition_continuation_budget(
        &self,
        write: ContinuationBudgetTransition,
    ) -> PortFuture<'_, Value> {
        let storage = self.storage.clone();
        Box::pin(async move {
            let result = storage
                .execute(move |db| budget::transition(db, &write))
                .await
                .map_err(btcc_error)?;
            if let Some(error) = result.terminal {
                return Err(error.into_btcc_error());
            }
            Ok(result.state)
        })
    }
}

impl CanonicalMessageStore for BtccRepositories {
    fn insert(&self, turn: &TurnRecord) -> PortFuture<'_, String> {
        let storage = self.storage.clone();
        let turn = CanonicalDelivery::from(turn);
        Box::pin(async move {
            storage
                .execute(move |db| canonical::insert(db, &turn))
                .await
                .map_err(btcc_error)
        })
    }
}
impl ProgressEventRepository for BtccRepositories {
    fn append(&self, write: ProgressWrite) -> PortFuture<'_, ()> {
        let storage = self.storage.clone();
        Box::pin(async move {
            storage
                .execute(move |db| progress::append(db, write))
                .await
                .map_err(btcc_error)
        })
    }
    fn first_destination(&self, turn_id: &str) -> PortFuture<'_, Option<ProgressDestination>> {
        let storage = self.storage.clone();
        let id = turn_id.to_owned();
        Box::pin(async move {
            storage
                .execute(move |db| progress::first_destination(db, &id))
                .await
                .map_err(btcc_error)
        })
    }
}
impl StorageReadiness for BtccRepositories {
    fn wait(&self, cancellation: CancellationToken) -> PortFuture<'_, ()> {
        let storage = self.storage.clone();
        Box::pin(async move { readiness::wait(&storage, cancellation).await })
    }
}
impl HostDependencies for BtccRepositories {
    fn close(&self) -> PortFuture<'_, ()> {
        Box::pin(async move { BtccRepositories::close(self).await.map_err(btcc_error) })
    }
}

impl BtccRepositories {
    pub(crate) fn new(
        storage: BtccStorage,
        continuation_limits: Option<TurnContinuationBudgetLimits>,
    ) -> Self {
        Self {
            storage,
            continuation_limits,
        }
    }

    pub(crate) fn context_compactions(&self) -> super::ContextCompactionRepository {
        super::ContextCompactionRepository::new(self.storage.clone())
    }

    pub(crate) async fn close(&self) -> Result<(), StorageError> {
        self.storage.close().await
    }
}
