//! Reviewed Steward Plan action to durable Worker dispatch.

use super::*;
use crate::btcc::storage::SubsessionDispatchState;
use crate::btcc::{BtccCode, BtccError};

impl SubsessionService {
    /// Delegates one executable action of a reviewed Workers-mode plan to a
    /// worker subsession. The delegation is idempotent.
    pub async fn delegate_worker(
        &self,
        mut request: WorkerDelegationRequest,
        reviewed: &WorkView,
    ) -> Result<Value, BtccError> {
        request.access_mode = self
            .delegated_access(
                &request.parent_session_id,
                &request.parent_turn_id,
                request.access_mode.clone(),
                None,
            )
            .await?;
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
            if let Some(output) = self.finished_worker_output(&existing).await? {
                return Ok(output);
            }
            return Ok(
                if existing.dispatch_state == SubsessionDispatchState::Pending {
                    self.worker_output(&existing).await?
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
        self.worker_output(&stored).await
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
    pub(super) async fn admit_waiting(&self, parent: &str) -> Result<(), BtccError> {
        let cap = self.read_worker_cap().await;
        while let Some(stored) = self
            .repository
            .admit_worker(parent.into(), cap)
            .await
            .map_err(BtccError::from)?
        {
            self.publish_worker(&stored).await?;
            self.notify_execution_changed(&stored.child_session_id)
                .await?;
        }
        Ok(())
    }

    pub(super) async fn prepare_child_binding(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let marker = if stored.packet.child_role == ChildRole::Worker {
            self.repository
                .worker_result_marker(stored.relation_id.clone())
                .await
                .map_err(BtccError::from)?
        } else {
            None
        };
        if let Err(error) = self.ensure_child_binding(stored).await {
            if stored.packet.child_role != ChildRole::Worker {
                return Err(error);
            }
            if self.worker_publish_error(stored, marker, &error).await? {
                return Err(error);
            }
            return Err(worker_start_failed());
        }
        Ok(())
    }

    pub(super) async fn publish_worker(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let marker = self
            .repository
            .worker_result_marker(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        let published = async {
            self.ensure_child_binding(stored).await?;
            self.enqueue_worker(stored).await
        }
        .await;
        if let Err(error) = published {
            if self.worker_publish_error(stored, marker, &error).await? {
                return Ok(());
            }
            return Err(worker_start_failed());
        }
        Ok(())
    }

    /// Known invalid identities and envelopes cannot improve on retry. I/O,
    /// storage availability and interrupted tasks keep their durable retry path.
    async fn worker_publish_error(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
        marker: Option<String>,
        error: &BtccError,
    ) -> Result<bool, BtccError> {
        let permanent = Self::worker_publish_error_is_permanent(error);
        if permanent {
            self.repository
                .fail_worker_publish(stored.relation_id.clone(), marker, error.code().into())
                .await
                .map_err(BtccError::from)?;
        } else {
            self.repository
                .worker_publish_failed(stored.relation_id.clone(), marker)
                .await
                .map_err(BtccError::from)?;
        }
        butler_core::diagnostic!(
            "[native-btcc] Worker publish failed terminal={} code={}",
            permanent,
            error.code()
        );
        Ok(permanent)
    }

    pub(super) fn worker_publish_error_is_permanent(error: &BtccError) -> bool {
        matches!(
            error.code(),
            "subsession_child_binding_mismatch"
                | "subsession_parent_binding_missing"
                | "subsession_dispatch_intent_invalid"
                | "subsession_direction_child_binding_missing"
                | "subsession_relation_missing"
                | "inbound_envelope_invalid"
                | "inbound_queue_encode_failed"
                | "inbound_queue_path_invalid"
                | "inbound_queue_time_invalid"
        )
    }

    /// Settings changes retry durable waiting work without polling.
    pub async fn admit_waiting_workers(&self) -> Result<(), BtccError> {
        self.admit_waiting_except(std::collections::HashSet::new())
            .await
    }

    pub(super) async fn admit_waiting_except(
        &self,
        excluded: std::collections::HashSet<String>,
    ) -> Result<(), BtccError> {
        let mut parents = std::collections::HashSet::new();
        for stored in self
            .repository
            .pending_dispatches()
            .await
            .map_err(BtccError::from)?
        {
            if stored.packet.child_role == ChildRole::Worker
                && !excluded.contains(&stored.parent_session_id)
            {
                parents.insert(stored.parent_session_id);
            }
        }
        for parent in parents {
            if let Err(error) = self.admit_waiting(&parent).await {
                butler_core::diagnostic!(
                    "[native-btcc] Worker admission deferred code={}",
                    error.code()
                );
            }
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
            if let Some(direction) = self
                .repository
                .pending_direction(stored.relation_id.clone())
                .await
                .map_err(BtccError::from)?
            {
                return self.enqueue_direction(stored, &direction).await;
            }
            return Ok(());
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
                self.worker_cap_error_logged.store(false, Relaxed);
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

fn worker_start_failed() -> BtccError {
    BtccError::detected(
        BtccCode::WorkerStartFailed,
        "The Worker could not be started, and nothing is running for it yet. Call delegate_to_worker again with the same request; retrying is safe and will not start it twice.",
    )
}

impl SubsessionService {
    pub(super) async fn worker_output(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<Value, BtccError> {
        if stored.dispatch_state == SubsessionDispatchState::Inactive
            && let Some(output) = self.finished_worker_output(stored).await?
        {
            return Ok(output);
        }
        let cap = self.cached_worker_cap();
        let waiting = stored.dispatch_state == SubsessionDispatchState::Pending;
        if waiting
            && self
                .repository
                .running_worker_count(stored.parent_session_id.clone())
                .await
                .map_err(BtccError::from)?
                < cap
        {
            return Err(worker_start_failed());
        }
        let mut output = json!({"ok":true,"status":if waiting {"waiting"} else {"queued"},"delegation_id":stored.delegation_id,"relation_id":stored.relation_id,"child_session_id":stored.child_session_id,"task_id":stored.task_id});
        if waiting && let Some(object) = output.as_object_mut() {
            object.insert("message".into(), json!(
                format!("Worker {} is waiting because this session already has {cap} Workers running. It starts automatically when one of them finishes, and its result arrives like any other. Continue your own work and do not dispatch it again.", stored.delegation_id)
            ));
        }
        Ok(output)
    }

    async fn finished_worker_output(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<Option<Value>, BtccError> {
        let result = self
            .repository
            .result_for_relation(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        Ok(result.map(|result| {
            json!({"ok":false,"relation_id":stored.relation_id,"result":result,
                "error":{"code":"delegation_already_finished","message":"This child has already returned its outcome. Resolve the reported blocker or revise the Plan/action and implementation approach before starting a new attempt. Do not wait for a terminal child."}})
        }))
    }
}
