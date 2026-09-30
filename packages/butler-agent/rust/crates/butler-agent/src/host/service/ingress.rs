//! One owned native inbound dispatcher for the existing durable App file queue.

mod action;
mod bind;
mod dispatch;
mod recovery;
mod shutdown;

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
};

use serde_json::Value;
use tokio::{sync::Mutex, task::JoinSet};

use crate::host::service::restart_handoff::RestartHandoff;
use butler_gateway::gateway::{InboundQueue, InboundQueueError};
use butler_turn::btcc::{Btcc, PrincipalAuthority};
use butler_turn::workspace::SessionBindingStore;

pub(crate) type DeliveryFuture = Pin<Box<dyn Future<Output = Result<bool, IngressError>> + Send>>;

pub(crate) trait IngressDelivery: Send + Sync + 'static {
    fn deliver(&self, session_id: String, action: Value) -> DeliveryFuture;
}

/// A failed inbound dispatch: the wire code and message recorded for the
/// queued event, plus the underlying error.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub(crate) struct IngressError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    #[source]
    source: Option<Arc<dyn std::error::Error + Send + Sync>>,
}

impl IngressError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }

    /// Records the underlying error.
    #[must_use]
    pub(crate) fn with_source(
        mut self,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        self.source = Some(Arc::new(source));
        self
    }
}

impl From<InboundQueueError> for IngressError {
    fn from(error: InboundQueueError) -> Self {
        Self::new(error.code(), error.message()).with_source(error)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct IngressPoll {
    pub(crate) claimed: usize,
    pub(crate) handled: usize,
    pub(crate) delivered: usize,
    pub(crate) failed: usize,
    pub(crate) interrupted: usize,
}

struct DispatchDone {
    session: String,
    queue_id: String,
    result: IngressPoll,
}

struct Lifecycle {
    closing: bool,
    active_sessions: HashSet<String>,
    active_queue_ids: HashSet<String>,
    task_keys: HashMap<tokio::task::Id, (String, String)>,
    tasks: JoinSet<DispatchDone>,
}

pub(crate) struct IngressDispatcher {
    queue: Arc<InboundQueue>,
    btcc: Btcc,
    authority: Arc<PrincipalAuthority>,
    bindings: SessionBindingStore,
    data_root: PathBuf,
    default_workspace: PathBuf,
    delivery: Arc<dyn IngressDelivery>,
    subsessions: Arc<butler_turn::btcc::SubsessionService>,
    restart_handoff: Arc<RestartHandoff>,
    lifecycle: Mutex<Lifecycle>,
    shutdown: tokio_util::sync::CancellationToken,
}

impl IngressDispatcher {
    #[expect(
        clippy::too_many_arguments,
        reason = "composition names each required queue, execution, authority, routing, delivery, and lifecycle owner"
    )]
    pub(crate) fn new(
        queue: Arc<InboundQueue>,
        btcc: Btcc,
        authority: Arc<PrincipalAuthority>,
        bindings: SessionBindingStore,
        data_root: PathBuf,
        default_workspace: PathBuf,
        delivery: Arc<dyn IngressDelivery>,
        subsessions: Arc<butler_turn::btcc::SubsessionService>,
        restart_handoff: Arc<RestartHandoff>,
    ) -> Self {
        Self {
            queue,
            btcc,
            authority,
            bindings,
            data_root,
            default_workspace,
            delivery,
            subsessions,
            restart_handoff,
            shutdown: tokio_util::sync::CancellationToken::new(),
            lifecycle: Mutex::new(Lifecycle {
                closing: false,
                active_sessions: HashSet::new(),
                active_queue_ids: HashSet::new(),
                task_keys: HashMap::new(),
                tasks: JoinSet::new(),
            }),
        }
    }

    pub(crate) async fn poll(&self) -> Result<IngressPoll, IngressError> {
        let mut state = self.lifecycle.lock().await;
        if state.closing {
            return Err(IngressError::new(
                "inbound_dispatcher_closed",
                "Inbound dispatcher closed",
            ));
        }
        let mut summary = IngressPoll::default();
        while let Some(done) = state.tasks.try_join_next_with_id() {
            match done {
                Ok((id, done)) => {
                    state.task_keys.remove(&id);
                    state.active_sessions.remove(&done.session);
                    state.active_queue_ids.remove(&done.queue_id);
                    summary.handled += done.result.handled;
                    summary.delivered += done.result.delivered;
                    summary.failed += done.result.failed;
                    summary.interrupted += done.result.interrupted;
                }
                Err(error) => {
                    if let Some((session, queue_id)) = state.task_keys.remove(&error.id()) {
                        state.active_sessions.remove(&session);
                        state.active_queue_ids.remove(&queue_id);
                    }
                    summary.interrupted += 1;
                }
            }
        }
        if summary.interrupted > 0 {
            return Ok(summary);
        }
        recover_stale(self.queue.clone(), state.active_queue_ids.clone()).await?;
        let capacity = dispatch_capacity().saturating_sub(state.tasks.len());
        let waiting_sessions = waiting_sessions(&self.authority).await?;
        let claimed = claim_pending(
            self.queue.clone(),
            capacity,
            waiting_sessions,
            state.active_sessions.clone(),
        )
        .await?;
        summary.claimed = claimed.len();
        for item in claimed {
            let session = dispatch::session_key(&item.record);
            let queue_id = item.record.queue_id.clone();
            state.active_sessions.insert(session.clone());
            state.active_queue_ids.insert(queue_id.clone());
            let key = (session.clone(), queue_id.clone());
            let deps = dispatch::DispatchDependencies {
                shutdown: self.shutdown.clone(),
                queue: self.queue.clone(),
                btcc: self.btcc.clone(),
                bindings: self.bindings.clone(),
                data_root: self.data_root.clone(),
                default_workspace: self.default_workspace.clone(),
                delivery: self.delivery.clone(),
                subsessions: self.subsessions.clone(),
                restart_handoff: self.restart_handoff.clone(),
            };
            let handle = state.tasks.spawn(async move {
                let result = dispatch::one(item, deps).await;
                DispatchDone {
                    session,
                    queue_id,
                    result,
                }
            });
            state.task_keys.insert(handle.id(), key);
        }
        Ok(summary)
    }

    /// Stop admission, fence active turns, and retain publication through completion.
    pub(crate) async fn close(&self) -> Result<(), IngressError> {
        let mut state = self.lifecycle.lock().await;
        state.closing = true;
        self.shutdown.cancel();
        while let Some(done) = state.tasks.join_next_with_id().await {
            match done {
                Ok((id, done)) => {
                    state.task_keys.remove(&id);
                    state.active_sessions.remove(&done.session);
                    state.active_queue_ids.remove(&done.queue_id);
                }
                Err(error) => {
                    if let Some((session, queue_id)) = state.task_keys.remove(&error.id()) {
                        state.active_sessions.remove(&session);
                        state.active_queue_ids.remove(&queue_id);
                    }
                }
            }
        }
        Ok(())
    }
}

async fn recover_stale(
    queue: Arc<InboundQueue>,
    active_ids: HashSet<String>,
) -> Result<(), IngressError> {
    tokio::task::spawn_blocking(move || queue.recover_stale_processing_except(&active_ids))
        .await
        .map_err(|error| IngressError::new("inbound_queue_worker_failed", error.to_string()))??;
    Ok(())
}

async fn claim_pending(
    queue: Arc<InboundQueue>,
    capacity: usize,
    waiting_sessions: HashSet<String>,
    active_sessions: HashSet<String>,
) -> Result<Vec<butler_gateway::gateway::ClaimedInboundEvent>, IngressError> {
    tokio::task::spawn_blocking(move || {
        let mut batch = HashSet::new();
        queue.claim_eligible(capacity, |record| {
            dispatch::eligible_for_claim(record, &waiting_sessions, &active_sessions, &mut batch)
        })
    })
    .await
    .map_err(|error| IngressError::new("inbound_queue_worker_failed", error.to_string()))?
    .map_err(IngressError::from)
}

async fn waiting_sessions(authority: &PrincipalAuthority) -> Result<HashSet<String>, IngressError> {
    authority
        .waiting_source_sessions()
        .await
        .map_err(|source| {
            IngressError::new(
                "inbound_authority_state_unavailable",
                "Waiting session state unavailable",
            )
            .with_source(source)
        })
        .map(|sessions| sessions.into_iter().collect())
}

fn dispatch_capacity() -> usize {
    #[cfg(debug_assertions)]
    if let Some(capacity) = std::env::var("BUTLER_E2E_INGRESS_CAPACITY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=16).contains(value))
    {
        return capacity;
    }
    5
}
