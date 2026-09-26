//! Reviewed Steward Plan action to durable Worker dispatch.

use super::*;

impl NativeSubsessionService {
    pub(crate) async fn delegate_worker(
        &self,
        request: WorkerDelegationRequest,
        reviewed: &WorkView,
    ) -> Result<Value, BtccError> {
        let parent = self
            .bindings
            .get_by_session_id(&request.parent_session_id)
            .await
            .map_err(workspace)?
            .ok_or_else(|| error("parent_steward_session_required"))?;
        if parent.role != SessionRole::Steward {
            return Err(error("parent_steward_session_required"));
        }
        let plan = reviewed
            .current_plan
            .as_ref()
            .ok_or_else(|| error("delegation_reviewed_plan_required"))?;
        if plan.execution_mode != Some(ExecutionMode::Workers) {
            return Err(error("worker_delegation_plan_mode_required"));
        }
        let review = reviewed
            .latest_plan_review
            .as_ref()
            .filter(|r| {
                r.verdict == crate::btcc::ReviewVerdict::Accept
                    && r.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
            })
            .ok_or_else(|| error("delegation_reviewed_plan_required"))?;
        let action = plan
            .actions
            .iter()
            .find(|a| a.action_key == request.action_key)
            .ok_or_else(|| error("worker_plan_action_missing"))?;
        let progress = reviewed
            .action_progress
            .iter()
            .find(|p| p.action_key == request.action_key)
            .map(|p| p.status)
            .unwrap_or(ActionStatus::Pending);
        if matches!(
            progress,
            ActionStatus::Done | ActionStatus::Skipped | ActionStatus::Blocked
        ) {
            return Err(error("worker_plan_action_not_executable"));
        }
        for dependency in &action.dependency_keys {
            let status = reviewed
                .action_progress
                .iter()
                .find(|p| &p.action_key == dependency)
                .map(|p| p.status);
            if !matches!(status, Some(ActionStatus::Done | ActionStatus::Skipped)) {
                return Err(error("worker_plan_action_dependency_incomplete"));
            }
        }
        let profile = self.profiles.read(request.profile_id.clone()).await?;
        let identity = json!({"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"action_key":request.action_key,"objective":request.objective,"acceptance_criteria":request.acceptance_criteria,"implementation_brief":request.implementation_brief,"profile_id":profile.id});
        let encoded =
            serde_json::to_string(&identity).map_err(|_| error("subsession_identity_invalid"))?;
        let delegation_id = format!(
            "delegation-{}",
            crate::btcc::digest_identity(&format!("btcc.worker.delegation.v1\0{encoded}"))
        );
        if let Some(existing) = self
            .repository
            .by_delegation(delegation_id.clone())
            .await
            .map_err(storage)?
        {
            self.ensure_child_binding(&existing).await?;
            self.replay(&existing).await?;
            return Ok(
                json!({"ok":true,"status":"queued","relation_id":existing.relation_id,"child_session_id":existing.child_session_id,"task_id":existing.task_id}),
            );
        }
        let relation_id = format!(
            "relation-{}",
            &crate::btcc::digest_identity(&format!("btcc.worker.relation.v1\0{delegation_id}"))
                [..40]
        );
        let task_id = format!(
            "worker-task-{}",
            &crate::btcc::digest_identity(&format!("btcc.worker.task.v1\0{delegation_id}"))[..40]
        );
        let child_session_id = format!(
            "worker-{}",
            &crate::btcc::digest_identity(&format!("btcc.worker.session.v1\0{relation_id}"))[..32]
        );
        let child_turn_id = format!(
            "worker-turn-{}",
            &crate::btcc::digest_identity(&format!("btcc.worker.turn.v1\0{relation_id}"))[..32]
        );
        let mutation_call_id =
            format!("subsession-root-work:{delegation_id}:{task_id}:{child_session_id}");
        let root_work_id = format!(
            "guided-work-{}",
            crate::btcc::digest_identity(&format!("btcc-guided-work.v1\0work\0{mutation_call_id}"))
        );
        let now = (self.now)();
        let packet = json!({"child_role":"worker","delegation_id":delegation_id,"source_tool_call_id":request.source_tool_call_id,"task_id":task_id,"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"relation_id":relation_id,"access_mode":request.access_mode,"execution_mode":if request.access_mode=="read_only"{"read_only"}else{"mutation"},"objective":request.objective,"acceptance_criteria":request.acceptance_criteria,"implementation_brief":request.implementation_brief,"plan_action":{"action_key":action.action_key,"description":action.description,"dependency_keys":action.dependency_keys},"task_or_plan_refs":[plan.plan_revision_id],"constraints_and_non_goals":["Execute only this bounded Task and report to the Steward."],"allowed_tools_and_effects":allowed_effects(&request.access_mode),"mutation_scope":mutation_scope(&request.access_mode),"parent_work_ref":{"work_id":reviewed.work_id,"session_id":reviewed.session_id,"turn_id":request.parent_turn_id,"plan_revision_id":plan.plan_revision_id,"review_revision_id":review.review_revision_id},"worker_profile":{"id":profile.id,"job":profile.job},"model_ref":profile.model_ref,"reasoning_effort":profile.reasoning_effort});
        let envelope = child_envelope(ChildEnvelopeInput {
            role: "worker",
            delegation: &delegation_id,
            child: &child_session_id,
            parent_id: &request.parent_session_id,
            turn: &child_turn_id,
            parent: &parent,
            model: &profile.model_ref,
            reasoning: &profile.reasoning_effort,
            text: render_input(&packet, profile.prompt.as_deref()),
            now: &now,
        });
        let intent = json!({"envelope":envelope,"metadata":{"source":"btcc-worker-delegation"}});
        self.repository
            .create(SubsessionCreate {
                relation_id: relation_id.clone(),
                delegation_id: delegation_id.clone(),
                task_id: task_id.clone(),
                parent_session_id: request.parent_session_id.clone(),
                parent_turn_id: request.parent_turn_id,
                child_session_id: child_session_id.clone(),
                child_turn_id: child_turn_id.clone(),
                anchor_message_id: request.anchor_message_id,
                safe_title: request.safe_title.unwrap_or_else(|| "Worker task".into()),
                root_work_id,
                packet: packet.clone(),
                dispatch_intent: intent.clone(),
                created_at: now,
            })
            .await
            .map_err(storage)?;
        let stored = self
            .repository
            .by_delegation(delegation_id)
            .await
            .map_err(storage)?
            .ok_or_else(|| error("subsession_persist_failed"))?;
        self.ensure_child_binding(&stored).await?;
        self.replay(&stored).await?;
        Ok(
            json!({"ok":true,"status":"queued","relation_id":relation_id,"child_session_id":child_session_id,"task_id":task_id}),
        )
    }
}
