//! One writer transaction admits the assignment and its recoverable dispatch.
use super::*;
use crate::btcc::subsessions::assignment::{Child, ChildAssignment};
use crate::btcc::{PacketExecutionMode, StoredSubsessionDelegation, SubsessionPacket};
use butler_core::json::at;
use butler_work::{store, work_types::TaskKind};
use rusqlite::{OptionalExtension, params};

pub(super) struct AssignmentRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub anchor_message_id: String,
    pub request: String,
    pub task_id: Option<String>,
    pub part_id: Option<String>,
    pub role: ChildRole,
    pub safe_title: Option<String>,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    pub parent_chat_id: Option<String>,
    pub prior_context: Option<String>,
    pub implementation_brief: Option<String>,
    pub worker_prompt: Option<String>,
    pub worker_profile: Option<crate::btcc::PacketWorkerProfile>,
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
}

pub(super) fn context() -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: json!({"runtime":"subsession"}),
    }
}

impl SubsessionService {
    pub(super) async fn admit_assignment(
        &self,
        input: AssignmentRequest,
        parent: crate::workspace::StoredSessionBinding,
    ) -> Result<Child, BtccError> {
        let session = input.parent_session_id.clone();
        let task = self
            .repository
            .storage()
            .work_model_read(move |db| {
                Ok(db
                    .query_row(
                        "SELECT current_task_id FROM wm_session_exec WHERE session_id=?1",
                        [session],
                        |r| r.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten())
            })
            .await
            .map_err(BtccError::from)?;
        let target = input
            .part_id
            .as_ref()
            .or(input.task_id.as_ref())
            .or(task.as_ref())
            .ok_or_else(|| {
                BtccError::relayed(
                    "delegation_task_required",
                    "Start a Task before delegating its parts.",
                )
            })?;
        let naming = if input.role == ChildRole::Worker {
            &delegation::WORKER
        } else {
            &delegation::STEWARD
        };
        let identity = json!([
            input.parent_session_id,
            input.parent_turn_id,
            target,
            input.request
        ]);
        let id = delegation::delegation_id(naming, &identity)?;
        if let Some(existing) = self.replay_existing(&id).await? {
            return Ok(existing);
        }
        let ids = delegation::DelegationIds::derive(naming, id);
        let now = (self.now)();
        let stored = self
            .repository
            .storage()
            .work_model_write(move |tx| assign(tx, &input, &parent, &ids, &now, task.as_deref()))
            .await
            .map_err(BtccError::from)?;
        self.ensure_child_binding(&stored).await?;
        self.replay(&stored).await?;
        Ok(stored)
    }
}

fn assign(
    tx: &store::Transaction<'_>,
    input: &AssignmentRequest,
    parent: &crate::workspace::StoredSessionBinding,
    ids: &delegation::DelegationIds,
    now: &str,
    task: Option<&str>,
) -> store::Result<Child> {
    let attempt = format!("attempt-{}", ids.delegation_id);
    if let Some(child) = existing_assignment(tx, &attempt)? {
        return Ok(child);
    }
    let ctx = context();
    let (task, part) = resolve_target(tx, &ctx, input, task, ids)?;
    let task_row = store::read_task(tx, &task)?;
    let work = string(&task_row, "work_id")?;
    if store::bound_work(tx, &input.parent_session_id, None)?
        .is_none_or(|row| at(&row, "/id") != work)
    {
        return Err(store::Error::Invalid("assignment outside parent Work"));
    }
    store::tiers::delegation_floor(tx, work)?;
    let child = store::ExecutionScope {
        session_id: &ids.child_session_id,
        turn_id: &ids.child_turn_id,
    };
    if let Some(part) = &part {
        let revision = at(&store::read_part(tx, part)?, "/revision")
            .as_i64()
            .ok_or(store::Error::Invalid("revision"))?;
        store::assign_part(
            tx,
            &ctx,
            part,
            revision,
            &input.parent_session_id,
            &child,
            &attempt,
        )?;
    } else {
        let revision = at(&task_row, "/revision")
            .as_i64()
            .ok_or(store::Error::Invalid("revision"))?;
        store::assign_task(tx, &ctx, &task, revision, &child, &attempt)?;
    }
    store::tiers::admit(tx, &ctx, &ids.child_session_id, work, 2, "delegated")?;
    store::tiers::bind_started_task(tx, &ids.child_session_id, &task)?;
    persist(tx, input, parent, ids, now, work, &task, part, &attempt)
}

fn existing_assignment(tx: &store::Transaction<'_>, attempt: &str) -> store::Result<Option<Child>> {
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM wm_cross_db_intents WHERE op_id=?1",
            [format!("child_dispatch:{attempt}")],
            |r| r.get(0),
        )
        .optional()?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let payload: Value = serde_json::from_str(&payload)?;
    let delegation: StoredSubsessionDelegation =
        serde_json::from_value(at(&payload, "/delegation").clone())?;
    let (task_id, part_id): (String, Option<String>) = tx.query_row(
        "SELECT task_id,part_id FROM wm_attempts WHERE id=?1",
        [attempt],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let work = store::read_task(tx, &task_id)?;
    let work_id = string(&work, "work_id")?.into();
    Ok(Some(Child::Assigned(ChildAssignment {
        delegation,
        task_id,
        part_id,
        work_id,
        attempt_id: attempt.into(),
    })))
}

fn resolve_target(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    input: &AssignmentRequest,
    current: Option<&str>,
    ids: &delegation::DelegationIds,
) -> store::Result<(String, Option<String>)> {
    if let Some(part) = &input.part_id {
        let row = store::read_part(tx, part)?;
        let task = string(&row, "task_id")?.to_owned();
        if input.task_id.as_ref().is_some_and(|id| *id != task) {
            return Err(store::Error::Invalid("part belongs to another Task"));
        }
        return Ok((task, Some(part.clone())));
    }
    if let Some(task) = &input.task_id {
        return Ok((task.clone(), None));
    }
    let task = current.ok_or(store::Error::Invalid("delegation_task_required"))?;
    let part = format!("part-{}", ids.delegation_id);
    store::add_part(
        tx,
        ctx,
        &store::NewPart {
            id: &part,
            task_id: task,
            kind: TaskKind::Execute,
            title: &delegation_title(input.safe_title.as_deref(), &input.request),
            after_part_ids: &[],
        },
    )?;
    Ok((task.into(), Some(part)))
}

#[allow(
    clippy::too_many_arguments,
    reason = "atomic assignment and transport metadata"
)]
fn persist(
    tx: &store::Transaction<'_>,
    input: &AssignmentRequest,
    parent: &crate::workspace::StoredSessionBinding,
    ids: &delegation::DelegationIds,
    now: &str,
    work: &str,
    task: &str,
    part: Option<String>,
    attempt: &str,
) -> store::Result<Child> {
    let packet = packet(tx, input, ids, task)?;
    let text = if input.role == ChildRole::Worker {
        render_input(&packet, input.worker_prompt.as_deref())
    } else {
        render_steward_input(&packet)
    };
    let envelope = child_envelope(ChildEnvelopeInput {
        role: input.role.as_str(),
        delegation: &ids.delegation_id,
        child: &ids.child_session_id,
        parent_id: &input.parent_session_id,
        turn: &ids.child_turn_id,
        parent,
        model: &input.model_ref,
        reasoning: &input.reasoning_effort,
        text,
        now,
        schedule_run: input.schedule_run.clone(),
    });
    let ordinal: i64 = tx.query_row(
        "SELECT coalesce(max(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?1",
        [&input.parent_session_id],
        |r| r.get(0),
    )?;
    let title = delegation_title(input.safe_title.as_deref(), &input.request);
    tx.execute("INSERT OR IGNORE INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?4)",
        params![ids.relation_id,input.parent_session_id,input.parent_turn_id,ids.child_session_id,input.anchor_message_id,ordinal,title,now,input.role.as_str()])?;
    let delegation = StoredSubsessionDelegation {
        relation_id: ids.relation_id.clone(),
        delegation_id: ids.delegation_id.clone(),
        task_id: task.into(),
        parent_session_id: input.parent_session_id.clone(),
        parent_turn_id: input.parent_turn_id.clone(),
        child_session_id: ids.child_session_id.clone(),
        child_turn_id: ids.child_turn_id.clone(),
        root_work_id: work.into(),
        packet,
        dispatch_intent: Some(DispatchIntent {
            envelope,
            metadata: DispatchMetadata {
                source: "btcc-subsession-delegation".into(),
            },
        }),
        anchor_message_id: input.anchor_message_id.clone(),
        ordinal,
        safe_title: title,
        created_at: now.into(),
    };
    store::record_intent(
        tx,
        &context(),
        &format!("child_dispatch:{attempt}"),
        "child_dispatch",
        &json!({"delegation":delegation}),
    )?;
    Ok(Child::Assigned(ChildAssignment {
        delegation,
        work_id: work.into(),
        task_id: task.into(),
        part_id: part,
        attempt_id: attempt.into(),
    }))
}

fn packet(
    tx: &store::Transaction<'_>,
    input: &AssignmentRequest,
    ids: &delegation::DelegationIds,
    task: &str,
) -> store::Result<SubsessionPacket> {
    let criteria = tx
        .prepare(store::execution_sql::CRITERIA)?
        .query_map([task], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let criteria = criteria.into_iter().map(|(node,revision,id)| tx.query_row(
        "SELECT text FROM wm_spec_criteria WHERE node_id=?1 AND revision=?2 AND criterion_id=?3", params![node,revision,id], |r| r.get::<_,String>(0)))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SubsessionPacket {
        child_role: input.role,
        delegation_id: ids.delegation_id.clone(),
        source_tool_call_id: None,
        task_id: task.into(),
        parent_session_id: input.parent_session_id.clone(),
        parent_turn_id: input.parent_turn_id.clone(),
        parent_chat_id: input.parent_chat_id.clone(),
        relation_id: ids.relation_id.clone(),
        access_mode: input.access_mode.clone(),
        execution_mode: PacketExecutionMode::for_access(&input.access_mode),
        objective: input.request.clone(),
        prior_context: input.prior_context.clone(),
        acceptance_criteria: criteria,
        implementation_brief: input.implementation_brief.clone(),
        plan_action: None,
        task_or_plan_refs: vec![task.into()],
        constraints_and_non_goals: vec![],
        allowed_tools_and_effects: allowed_effects(&input.access_mode),
        mutation_scope: mutation_scope(&input.access_mode),
        parent_work_ref: None,
        worker_profile: input.worker_profile.clone(),
        model_ref: input.model_ref.clone(),
        reasoning_effort: input.reasoning_effort.clone(),
        schedule_run: input.schedule_run.clone(),
    })
}

pub(super) fn string<'a>(row: &'a Value, field: &str) -> store::Result<&'a str> {
    row[field]
        .as_str()
        .ok_or(store::Error::Invalid("missing assignment field"))
}
