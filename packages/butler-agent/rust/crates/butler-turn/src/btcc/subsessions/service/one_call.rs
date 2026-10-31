//! Butler's complete handoff; dispatch happens only after the writer commits.
use super::*;
use crate::btcc::{StorageCode, StorageError};

impl SubsessionService {
    /// Reads an explicitly named delegated parent Work owned by this session.
    pub async fn delegated_parent_work(
        &self,
        session: String,
        work: String,
    ) -> Result<Option<WorkView>, BtccError> {
        let Some((turn, result, status)) = self
            .repository
            .settled_parent_source(session, work.clone())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(None);
        };
        let view = self.work.work_for_turn(turn, work).await?;
        Ok(view.filter(|view| runtime_settled(view, &result, &status)))
    }

    /// Whether this Steward's own root Work currently has an accepting Plan review.
    pub async fn steward_plan_ready(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<Option<bool>, BtccError> {
        let Some(relation) = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
            .filter(|relation| relation.packet.child_role == ChildRole::Steward)
        else {
            return Ok(None);
        };
        let work = self.work.bound_work_for_turn(turn.into()).await?;
        Ok(Some(work.as_ref().is_some_and(|work| {
            (work.work_id == relation.root_work_id || turn != relation.child_turn_id)
                && work.current_plan.as_ref().is_some_and(|plan| {
                    work.latest_plan_review.as_ref().is_some_and(|review| {
                        review.verdict == crate::btcc::ReviewVerdict::Accept
                            && review.bound_plan_revision_id.as_deref()
                                == Some(&plan.plan_revision_id)
                    })
                })
        })))
    }

    /// Creates the parent Plan and child intent atomically, without a parent review.
    pub async fn handoff_steward(
        &self,
        request: StewardDelegationRequest,
        scope: WorkTurnScope,
        mutation_call_id: String,
        checks: Option<Vec<String>>,
        epic_ref: Option<String>,
    ) -> Result<Value, BtccError> {
        let request = self.inherit_steward_access(request).await?;
        let parent = self
            .parent_binding(
                &request.parent_session_id,
                SessionRole::Butler,
                BtccCode::ParentButlerSessionRequired,
            )
            .await?;
        let chat = parent
            .transport_bindings
            .iter()
            .find(|binding| binding.transport == "app" && !binding.peer_id.trim().is_empty())
            .map(|binding| binding.peer_id.clone())
            .ok_or_else(|| error(BtccCode::ParentAppBindingRequired))?;
        let prior = self.followup_context(&request).await?;
        // Explicit handoff inputs replace legacy Plan content rather than being dropped.
        let reuse_reviewed = checks.is_none() && epic_ref.is_none();
        let now = (self.now)();
        if scope.turn_id != request.parent_turn_id || scope.session_id != request.parent_session_id
        {
            return Err(BtccError::relayed(
                "handoff_scope_mismatch",
                "Handoff scope does not match its parent",
            ));
        }
        if scope.project_ref.is_some() {
            return self
                .project_handoff(request, scope, mutation_call_id, checks, epic_ref)
                .await;
        }
        let call_id = mutation_call_id.clone();
        let stored = self
            .repository
            .create_handoff(
                scope,
                mutation_call_id,
                request.request.clone(),
                (
                    checks.unwrap_or_default(),
                    epic_ref.into_iter().collect(),
                    reuse_reviewed,
                ),
                now.clone(),
                move |work| {
                    build(
                        &request,
                        &parent,
                        chat.clone(),
                        &work,
                        prior.clone(),
                        &call_id,
                        &now,
                    )
                },
            )
            .await
            .map_err(BtccError::from)?;
        if self
            .repository
            .result_for_relation(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_none()
        {
            self.prepare_child_binding(&stored).await?;
            self.replay(&stored).await?;
        }
        Ok(delegation_output(&stored))
    }
}

pub(super) fn build(
    request: &StewardDelegationRequest,
    parent: &crate::workspace::StoredSessionBinding,
    chat: String,
    work: &WorkView,
    prior: Option<String>,
    call_id: &str,
    now: &str,
) -> Result<SubsessionCreate, StorageError> {
    let plan = work.current_plan.as_ref().ok_or_else(|| {
        StorageError::new(
            StorageCode::SubsessionPacketInvalid,
            "Handoff Plan is missing",
        )
    })?;
    let review = work.latest_plan_review.as_ref().filter(|review| {
        review.verdict == crate::btcc::ReviewVerdict::Accept
            && review.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
    });
    let identity = packets::steward_identity(request, work, (plan, review));
    let id = delegation::delegation_id(&delegation::STEWARD, &identity).map_err(|error| {
        StorageError::new(StorageCode::SubsessionPacketInvalid, error.message())
    })?;
    let ids = delegation::DelegationIds::derive(&delegation::STEWARD, id);
    let mut packet = packets::steward(&ids, request, chat, work, (plan, review));
    packet.source_tool_call_id = Some(call_id.into());
    packet.prior_context = prior;
    let envelope = child_envelope(ChildEnvelopeInput {
        role: "steward",
        delegation: &ids.delegation_id,
        child: &ids.child_session_id,
        parent_id: &request.parent_session_id,
        turn: &ids.child_turn_id,
        parent,
        model: &request.model_ref,
        reasoning: &request.reasoning_effort,
        text: render_steward_input(&packet),
        now,
        schedule_run: packet.schedule_run.clone(),
    });
    Ok(ids.create(
        delegation::Parent {
            session_id: request.parent_session_id.clone(),
            turn_id: request.parent_turn_id.clone(),
            anchor_message_id: request.anchor_message_id.clone(),
        },
        helpers::delegation_title(request.safe_title.as_deref(), &request.request),
        packet,
        DispatchIntent {
            envelope,
            metadata: DispatchMetadata {
                source: "btcc-subsession-delegation".into(),
            },
        },
        now.into(),
    ))
}

fn runtime_settled(work: &WorkView, result: &str, status: &str) -> bool {
    if work.status == crate::btcc::DurableWorkStatus::Abandoned {
        return matches!(status, "cancelled" | "abandoned");
    }
    let id = match work.scope {
        crate::btcc::WorkScope::Session { .. } => format!("steward-result-disposition:{result}"),
        crate::btcc::WorkScope::Project { .. } => {
            let mutation = crate::btcc::digest_identity(&format!("one-call-result\0{result}"));
            let digest = crate::btcc::digest_identity(&format!(
                "btcc-guided-work.v1\0disposition\0{mutation}"
            ));
            format!("guided-disposition-{digest}")
        }
    };
    work.latest_disposition
        .as_ref()
        .is_some_and(|disposition| disposition.disposition_revision_id == id)
}
