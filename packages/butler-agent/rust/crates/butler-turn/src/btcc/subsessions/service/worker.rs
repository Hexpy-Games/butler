//! Reviewed Steward Plan action to durable Worker dispatch.

use super::*;
use crate::btcc::storage::SubsessionDispatchState;
use crate::btcc::{BtccCode, BtccError};

impl SubsessionService {
    /// Delegates one executable action of a reviewed Workers-mode plan to a
    /// worker subsession. The delegation is idempotent.
    pub async fn delegate_worker(
        &self,
        request: WorkerDelegationRequest,
        reviewed: &WorkView,
    ) -> Result<Value, BtccError> {
        let parent = self
            .parent_binding(
                &request.parent_session_id,
                SessionRole::Steward,
                BtccCode::ParentStewardSessionRequired,
            )
            .await?;
        let (plan, review) = accepted_plan(
            reviewed,
            ExecutionMode::Workers,
            BtccCode::WorkerDelegationPlanModeRequired,
        )?;
        let action = executable_action(reviewed, plan, &request.action_key)?;
        let profile = self.profiles.read(request.profile_id.clone()).await?;
        let identity = packets::worker_identity(&request, &profile);
        let delegation_id = delegation::delegation_id(&delegation::WORKER, &identity)?;
        if let Some(existing) = self.replay_existing(&delegation_id).await? {
            if let Some(result) = self
                .repository
                .result_for_relation(existing.relation_id.clone())
                .await
                .map_err(BtccError::from)?
            {
                return Ok(
                    json!({"ok":false,"relation_id":existing.relation_id,"result":result,
                    "error":{"code":"delegation_already_finished","message":"This child has already returned its outcome. Resolve the reported blocker or revise the Plan/action and implementation approach before starting a new attempt. Do not wait for a terminal child."}}),
                );
            }
            return Ok(
                if existing.dispatch_state == SubsessionDispatchState::Pending {
                    worker_output(&existing, self.cached_worker_cap())
                } else {
                    super::helpers::existing_delegation_output(&existing)
                },
            );
        }
        let ids = delegation::DelegationIds::derive(&delegation::WORKER, delegation_id);
        let now = (self.now)();
        let packet = packets::worker(&ids, &request, action, &profile, reviewed, (plan, review));
        let envelope = child_envelope(ChildEnvelopeInput {
            role: "worker",
            delegation: &ids.delegation_id,
            child: &ids.child_session_id,
            parent_id: &request.parent_session_id,
            turn: &ids.child_turn_id,
            parent: &parent,
            model: &profile.model_ref,
            reasoning: &profile.reasoning_effort,
            text: render_input(&packet, profile.prompt.as_deref()),
            now: &now,
            schedule_run: packet.schedule_run.clone(),
        });
        let intent = DispatchIntent {
            envelope,
            metadata: DispatchMetadata {
                source: "btcc-worker-delegation".into(),
            },
        };
        let stored = self
            .create_and_dispatch(ids.create(
                delegation::Parent {
                    session_id: request.parent_session_id,
                    turn_id: request.parent_turn_id,
                    anchor_message_id: request.anchor_message_id,
                },
                request.safe_title.unwrap_or_else(|| "Worker task".into()),
                packet,
                intent,
                now,
            ))
            .await?;
        Ok(worker_output(&stored, self.cached_worker_cap()))
    }
}

/// The plan action to delegate: not finished or blocked, with every
/// dependency done or skipped.
fn executable_action<'a>(
    reviewed: &WorkView,
    plan: &'a crate::btcc::WorkPlan,
    action_key: &str,
) -> Result<&'a crate::btcc::PlanAction, BtccError> {
    let action = plan
        .actions
        .iter()
        .find(|a| a.action_key == action_key)
        .ok_or_else(|| error(BtccCode::WorkerPlanActionMissing))?;
    let status = |key: &str| {
        reviewed
            .action_progress
            .iter()
            .find(|p| p.action_key == key)
            .map(|p| p.status)
    };
    if matches!(
        status(action_key).unwrap_or(ActionStatus::Pending),
        ActionStatus::Done | ActionStatus::Skipped | ActionStatus::Blocked
    ) {
        return Err(error(BtccCode::WorkerPlanActionNotExecutable));
    }
    if action.dependency_keys.iter().any(|dependency| {
        !matches!(
            status(dependency),
            Some(ActionStatus::Done | ActionStatus::Skipped)
        )
    }) {
        return Err(error(BtccCode::WorkerPlanActionDependencyIncomplete));
    }
    Ok(action)
}

impl SubsessionService {
    /// Settings are read before admission, with no global lock across I/O.
    pub(super) async fn release_worker_slots(&self, parent: &str) -> Result<(), BtccError> {
        let cap = self.read_worker_cap().await;
        while let Some(stored) = self
            .repository
            .admit_worker(parent.into(), cap)
            .await
            .map_err(BtccError::from)?
        {
            self.ensure_child_binding(&stored).await?;
            self.enqueue_worker(&stored).await?;
            self.notify_execution_changed(&stored.child_session_id)
                .await?;
        }
        Ok(())
    }

    pub(super) async fn enqueue_worker(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        if self
            .repository
            .worker_first_turn_ended(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?
        {
            return self
                .release_pending_direction(&stored.child_session_id)
                .await;
        }
        let intent = stored
            .dispatch_intent
            .as_ref()
            .ok_or_else(|| error(BtccCode::SubsessionDispatchIntentInvalid))?;
        let envelope = serde_json::to_value(&intent.envelope).map_err(|source| {
            error(BtccCode::SubsessionDispatchIntentInvalid).with_source(source)
        })?;
        self.enqueue_child(SubsessionEnqueue {
            envelope,
            metadata: Map::new(),
        })
        .await
    }

    pub(super) async fn enqueue_child(&self, input: SubsessionEnqueue) -> Result<(), BtccError> {
        let queue = self.queue.clone();
        tokio::task::spawn_blocking(move || queue.enqueue(input))
            .await
            .map_err(|source| error(BtccCode::BtccTaskFailed).with_source(source))?
    }

    fn cached_worker_cap(&self) -> u64 {
        self.worker_cap.load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn read_worker_cap(&self) -> u64 {
        use std::sync::atomic::Ordering::Relaxed;
        match self.profiles.max_simultaneous_workers().await {
            Ok(cap) => {
                let cap = cap.clamp(1, 10);
                self.worker_cap.store(cap, Relaxed);
                cap
            }
            Err(error) => {
                if !self.worker_cap_error_logged.swap(true, Relaxed) {
                    butler_core::diagnostic!(
                        "[native-btcc] Worker cap settings unavailable; using last cap code={}",
                        error.code()
                    );
                }
                self.cached_worker_cap()
            }
        }
    }
}

pub(super) fn worker_output(stored: &crate::btcc::StoredSubsessionDelegation, cap: u64) -> Value {
    let waiting = stored.dispatch_state == SubsessionDispatchState::Pending;
    let mut output = json!({"ok":true,"status":if waiting {"waiting"} else {"queued"},"delegation_id":stored.delegation_id,"relation_id":stored.relation_id,"child_session_id":stored.child_session_id,"task_id":stored.task_id});
    if waiting && let Some(object) = output.as_object_mut() {
        object.insert("message".into(), json!(
            format!("Worker {} is waiting because this session already has {cap} Workers running. It starts automatically when one of them finishes, and its result arrives like any other. Continue your own work and do not dispatch it again.", stored.delegation_id)
        ));
    }
    output
}
