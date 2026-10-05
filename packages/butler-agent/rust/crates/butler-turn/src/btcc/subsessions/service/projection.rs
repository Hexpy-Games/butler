//! Read-only App projection from the BTCC subsession authority.

use serde_json::{Value, json};

use super::SubsessionService;
use crate::btcc::{BtccCode, StorageCode};
use crate::btcc::{BtccError, StoredSubsessionDelegation};

impl SubsessionService {
    /// The user-facing session that owns decisions for this delegation chain.
    /// Resolve durable relations, never model-supplied parent identifiers.
    pub async fn authority_owner(&self, session_id: &str) -> Result<String, BtccError> {
        let mut owner = session_id.to_owned();
        let mut visited = std::collections::HashSet::new();
        while visited.insert(owner.clone()) {
            let Some(relation) = self
                .repository
                .by_child(owner.clone())
                .await
                .map_err(BtccError::from)?
            else {
                return Ok(owner);
            };
            owner = relation.parent_session_id;
        }
        Err(BtccError::relayed(
            "subsession_relation_cycle",
            "Delegation relations contain a cycle.",
        ))
    }

    /// Prompt lines describing the parent's worker tasks.
    pub async fn worker_prompt_lines(
        &self,
        parent_session_id: String,
        task_ids: Vec<String>,
    ) -> Result<Vec<String>, BtccError> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        let wanted = task_ids
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let relations = self
            .repository
            .relations_for_parent(parent_session_id)
            .await
            .map_err(BtccError::from)?;
        let mut lines = Vec::new();
        for relation in relations
            .into_iter()
            .filter(|relation| wanted.contains(&relation.task_id))
            .take(8)
        {
            if relation.packet.child_role != crate::btcc::ChildRole::Worker {
                continue;
            }
            let projected = self.project_child(&relation).await?;
            let status = projected
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("waiting");
            let phase = relation.packet.execution_mode.as_str();
            let summary = projected
                .pointer("/result/summary")
                .and_then(Value::as_str)
                .or(Some(relation.packet.objective.as_str()))
                .unwrap_or(&relation.safe_title);
            lines.push(format!(
                "- {}: {status}; {phase}; {summary}",
                relation.task_id
            ));
        }
        Ok(lines)
    }

    /// Visible parent execution presence, excluding interrupted child turns.
    pub async fn running_parents(&self, parents: Vec<String>) -> Result<Vec<String>, BtccError> {
        let candidates = self
            .repository
            .running_descendants(parents)
            .await
            .map_err(BtccError::from)?;
        let mut running = std::collections::HashSet::new();
        for (parent, relation) in candidates {
            if !running.contains(&parent) && !self.child_recoverable(&relation).await? {
                running.insert(parent);
            }
        }
        Ok(running.into_iter().collect())
    }

    /// The App projection of a session's subsessions.
    pub async fn app_projection(&self, session_id: &str) -> Result<Value, BtccError> {
        let relations = self
            .repository
            .projection_relations(session_id.into())
            .await
            .map_err(BtccError::from)?;
        // An undecodable child row projects as no relation instead of failing.
        let relation = match relations.own {
            Err(error) if error.code() == StorageCode::SubsessionPacketInvalid.as_str() => {
                butler_core::diagnostic!("[native-btcc] undecodable subsession child row ignored");
                None
            }
            other => other.map_err(BtccError::from)?,
        };
        let mut summaries = Vec::new();
        for child in relations.children {
            summaries.push(self.project_child(&child).await?);
        }
        let (stewards, workers): (Vec<_>, Vec<_>) = summaries
            .into_iter()
            .partition(|value| value.get("role").and_then(Value::as_str) == Some("steward"));
        let own = if let Some(relation) = relation {
            Some(self.project_child(&relation).await?)
        } else {
            None
        };
        let mut projection =
            own.unwrap_or_else(|| json!({"session_id":session_id,"relation":null,"status":"idle"}));
        let object = projection.as_object_mut().ok_or_else(|| {
            BtccError::detected(BtccCode::SubsessionProjectionInvalid, "projection invalid")
        })?;
        object.insert("steward_children".into(), json!(stewards));
        object.insert("workers".into(), json!(workers));
        Ok(projection)
    }

    async fn project_child(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<Value, BtccError> {
        let latest = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?;
        let result = self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        let role = relation.packet.child_role.as_str();
        let status = projected_status(result.as_ref(), latest.as_ref());
        let retryable = if result.is_none() {
            self.child_recoverable(relation).await?
        } else {
            false
        };
        let turn=latest.as_ref().map(|(id,state)|json!({"id":id,"state":if retryable { "runtime_fault" } else { state },"retryable":retryable,"cancellable":state == "admitted" && !retryable,"created_at":relation.created_at,"updated_at":relation.created_at}));
        let relation_view = json!({"relation_id":relation.relation_id,"parent_session_id":relation.parent_session_id,"parent_turn_id":relation.parent_turn_id,"child_session_id":relation.child_session_id,"anchor_message_id":relation.anchor_message_id,"ordinal":relation.ordinal,"safe_title":relation.safe_title,"created_at":relation.created_at});
        let result_view = result.map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.insert("relation_id".into(), json!(relation.relation_id));
                object.insert("task_id".into(), json!(relation.task_id));
                object.insert("child_session_id".into(), json!(relation.child_session_id));
            }
            value
        });
        let waiting_for_children = result_view.is_none()
            && self
                .waiting_for_children(&relation.child_session_id)
                .await?;
        let mut projection = json!({"role":role,"relation":relation_view,"session_id":relation.child_session_id,"title":relation.safe_title,"status":status,"active_turn":if status=="active" && !retryable{turn.clone()}else{None},"latest_turn":turn,"waiting_for_children":waiting_for_children,"result":result_view,"updated_at":relation.created_at,"terminal":result_view.is_some()});
        if let Some((id, _)) = &latest {
            self.plan_counters(id, &mut projection).await?;
        }
        Ok(projection)
    }
}

impl SubsessionService {
    async fn waiting_for_children(&self, session: &str) -> Result<bool, BtccError> {
        for child in self
            .repository
            .relations_for_parent(session.into())
            .await
            .map_err(BtccError::from)?
        {
            if self
                .repository
                .result_for_relation(child.relation_id)
                .await
                .map_err(BtccError::from)?
                .is_none()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn child_recoverable(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        if self
            .repository
            .open_relation_by_work(relation.root_work_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_none()
        {
            return Ok(false);
        }
        let Some(turn) = self
            .repository
            .latest_resume_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(false);
        };
        if turn.semantic_state != "admitted" {
            return Ok(false);
        }
        let queue = self.queue.clone();
        let session = relation.child_session_id.clone();
        tokio::task::spawn_blocking(move || {
            Ok(queue
                .interrupted_event(&turn.original_event_id, &session, &turn.turn_id)?
                .is_some_and(|event| {
                    event.event_id == turn.original_event_id
                        && event.message_id == turn.original_message_id
                        && event.message == turn.original_message
                }))
        })
        .await
        .map_err(|error| {
            BtccError::detected(
                BtccCode::SubsessionProjectionInvalid,
                "Child recovery projection failed",
            )
            .with_source(error)
        })?
    }

    async fn plan_counters(&self, turn_id: &str, projection: &mut Value) -> Result<(), BtccError> {
        let work = match self.work.bound_work_for_turn(turn_id.to_owned()).await {
            Ok(work) => work,
            // Legacy children without a durable Work binding have no plan.
            Err(error)
                if matches!(
                    error.code(),
                    "work_scope_session_binding_missing" | "work_scope_turn_missing"
                ) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        let Some(work) = work else {
            return Ok(());
        };
        let Some(plan) = &work.current_plan else {
            return Ok(());
        };
        if !work.latest_plan_review.as_ref().is_some_and(|review| {
            review.verdict == crate::btcc::ReviewVerdict::Accept
                && review.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
        }) {
            return Ok(());
        }
        let completed = plan
            .actions
            .iter()
            .filter(|action| {
                work.action_progress.iter().any(|progress| {
                    progress.action_key == action.action_key
                        && progress.status == crate::btcc::ActionStatus::Done
                })
            })
            .count();
        projection["approved_plan_revision"] = json!(plan.revision);
        projection["approved_plan_total"] = json!(plan.actions.len());
        projection["approved_plan_completed"] = json!(completed);
        Ok(())
    }
}

fn projected_status(result: Option<&Value>, latest: Option<&(String, String)>) -> &'static str {
    match result
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
    {
        Some("success") => "completed",
        Some("cancelled") => "cancelled",
        Some("blocked") => "blocked",
        Some("failed") => "failed",
        _ if latest.is_some_and(|(_, state)| state == "admitted") => "active",
        _ => "waiting",
    }
}
