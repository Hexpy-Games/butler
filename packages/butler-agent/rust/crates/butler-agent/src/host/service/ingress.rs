//! One owned native inbound dispatcher for the existing durable App file queue.

mod action;
mod bind;
mod dispatch;

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
        self.queue
            .recover_stale_processing_except(&state.active_queue_ids)?;
        let capacity = 5usize.saturating_sub(state.tasks.len());
        let waiting_sessions = self
            .authority
            .waiting_source_sessions()
            .await
            .map_err(|source| {
                IngressError::new(
                    "inbound_authority_state_unavailable",
                    "Waiting session state unavailable",
                )
                .with_source(source)
            })?
            .into_iter()
            .collect::<HashSet<_>>();
        let mut batch = HashSet::new();
        let claimed = self.queue.claim_eligible(capacity, |record| {
            dispatch::eligible_for_claim(
                record,
                &waiting_sessions,
                &state.active_sessions,
                &mut batch,
            )
        })?;
        summary.claimed = claimed.len();
        for item in claimed {
            let session = dispatch::session_key(&item.record);
            let queue_id = item.record.queue_id.clone();
            state.active_sessions.insert(session.clone());
            state.active_queue_ids.insert(queue_id.clone());
            let key = (session.clone(), queue_id.clone());
            let deps = dispatch::DispatchDependencies {
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

    /// Stop admission and retain every task through completion.
    pub(crate) async fn close(&self) -> Result<(), IngressError> {
        let mut state = self.lifecycle.lock().await;
        state.closing = true;
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
