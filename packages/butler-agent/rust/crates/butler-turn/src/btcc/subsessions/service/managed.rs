//! Initial Tier 2 assignment through the existing durable child queue.
use super::*;
use crate::btcc::SubsessionPacket;
use crate::btcc::work_model::{TaskCard, stable_id};

pub struct ManagedDelegation {
    pub session: String,
    pub turn: String,
    pub call: String,
    pub message: String,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    pub worker: bool,
}

impl SubsessionService {
    pub async fn delegate_managed(&self, request: ManagedDelegation) -> Result<Value, BtccError> {
        let model = self
            .work
            .work_model()
            .ok_or_else(|| BtccError::relayed("work_model_disabled", "work_model_disabled"))?;
        let id = stable_id(
            "delegation",
            &request.session,
            &format!("{}:{}", request.turn, request.call),
        )?;
        if let Some(existing) = self.replay_existing(&id).await? {
            return output(model, &existing).await;
        }
        let task = model.delegation_task(request.session.clone()).await?;
        let parent = self
            .bindings
            .get_by_session_id(&request.session)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionChildBindingMissing))?;
        let naming = if request.worker || parent.role != SessionRole::Butler {
            &delegation::WORKER
        } else {
            &delegation::STEWARD
        };
        let ids = delegation::DelegationIds::derive(naming, id);
        let specification = model
            .read_spec(request.session.clone(), task.spec_ref.node_id.clone())
            .await?;
        let mut packet = packet(&ids, &request, &task, &specification)?;
        inherit_scope(&mut packet, &parent)?;
        packet.parent_chat_id = parent
            .transport_bindings
            .iter()
            .find(|b| b.transport == "app")
            .map(|b| b.peer_id.clone());
        let now = (self.now)();
        let envelope = child_envelope(ChildEnvelopeInput {
            role: packet.child_role.as_str(),
            delegation: &ids.delegation_id,
            child: &ids.child_session_id,
            parent_id: &request.session,
            turn: &ids.child_turn_id,
            parent: &parent,
            model: &request.model_ref,
            reasoning: &request.reasoning_effort,
            text: format!(
                "Execute assigned canonical Task {} in Work {} (source revision {}). Start it, read exact Spec/ancestors, submit results and evidence, then report to your parent for criterion review. Do not create a root Work or complete your own delegated Task.\n{}",
                task.id,
                task.work_id,
                task.revision,
                packet.implementation_brief.as_deref().unwrap_or_default()
            ),
            now: &now,
        });
        let intent = DispatchIntent {
            envelope,
            metadata: DispatchMetadata {
                source: "btcc-work-model-delegation".into(),
            },
        };
        let stored = self
            .create_and_dispatch(ids.create(
                delegation::Parent {
                    session_id: request.session,
                    turn_id: request.turn,
                    anchor_message_id: request.message,
                },
                task.description.clone(),
                packet,
                intent,
                now,
            ))
            .await?;
        model.changed().notify_one();
        output(model, &stored).await
    }
}

async fn output(
    model: &crate::btcc::work_model::WorkModelService,
    stored: &crate::btcc::StoredSubsessionDelegation,
) -> Result<Value, BtccError> {
    let mut value = canonical_output(stored)?;
    let authority = model
        .instruction_authority(stored.child_session_id.clone())
        .await?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| error(BtccCode::BtccJsonError))?;
    for key in ["relation_epoch", "control_epoch"] {
        object.insert(
            key.into(),
            authority.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    Ok(value)
}

fn packet(
    ids: &delegation::DelegationIds,
    request: &ManagedDelegation,
    task: &TaskCard,
    specification: &Value,
) -> Result<SubsessionPacket, BtccError> {
    Ok(SubsessionPacket {
        child_role: if request.worker {
            ChildRole::Worker
        } else {
            ChildRole::Steward
        },
        delegation_id: ids.delegation_id.clone(),
        source_tool_call_id: Some(request.call.clone()),
        task_id: task.id.clone(),
        parent_session_id: request.session.clone(),
        parent_turn_id: request.turn.clone(),
        parent_chat_id: None,
        relation_id: ids.relation_id.clone(),
        access_mode: request.access_mode.clone(),
        execution_mode: crate::btcc::PacketExecutionMode::for_access(&request.access_mode),
        objective: task.description.clone(),
        acceptance_criteria: task.criterion_ids.clone(),
        implementation_brief: Some(specification.to_string()),
        plan_action: None,
        task_or_plan_refs: vec![
            task.spec_ref.ledger_revision_id.clone(),
            task.work_id.clone(),
        ],
        constraints_and_non_goals: vec![],
        allowed_tools_and_effects: allowed_effects(&request.access_mode),
        mutation_scope: mutation_scope(&request.access_mode),
        parent_work_ref: None,
        worker_profile: None,
        model_ref: request.model_ref.clone(),
        reasoning_effort: request.reasoning_effort.clone(),
    })
}

fn canonical_output(stored: &crate::btcc::StoredSubsessionDelegation) -> Result<Value, BtccError> {
    let mut output = delegation_output(stored);
    let object = output.as_object_mut().ok_or_else(|| {
        BtccError::relayed("delegation_output_invalid", "delegation_output_invalid")
    })?;
    object.insert("task_id".into(), json!(stored.packet.task_id));
    object.insert(
        "root_work_id".into(),
        json!(
            stored
                .packet
                .task_or_plan_refs
                .get(1)
                .ok_or_else(|| BtccError::relayed(
                    "delegation_output_invalid",
                    "delegation_output_invalid"
                ))?
        ),
    );
    Ok(output)
}

fn inherit_scope(
    packet: &mut SubsessionPacket,
    parent: &crate::workspace::StoredSessionBinding,
) -> Result<(), BtccError> {
    if parent.role == SessionRole::Butler {
        return Ok(());
    }
    packet.child_role = ChildRole::Worker;
    let inherited = crate::btcc::subsessions::read_subsession_metadata(
        parent.metadata.as_ref().and_then(|m| m.get("subsession")),
    )?
    .ok_or_else(|| {
        BtccError::relayed("subsession_context_invalid", "Subsession context missing")
    })?;
    packet
        .allowed_tools_and_effects
        .retain(|e| inherited.allowed_tools_and_effects.contains(e));
    packet.mutation_scope = inherited.mutation_scope;
    Ok(())
}
