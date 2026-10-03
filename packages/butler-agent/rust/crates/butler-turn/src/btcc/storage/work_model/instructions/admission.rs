use super::*;

pub(super) fn admit(
    db: &Connection,
    session: &str,
    sender: &InstructionSender,
    input: &InstructionInput,
    transport_turn: Option<String>,
) -> Result<Value> {
    check(
        !input.idempotency_key.trim().is_empty(),
        "idempotency_key_required",
    )?;
    let hash = fingerprint(&(sender, input))?;
    let prior: Option<(String,String)> = db.query_row("SELECT payload_hash,receipt_json FROM wm_instructions WHERE session_id=?1 AND operation_key=?2", params![session,input.idempotency_key], |r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    if let Some((expected, receipt)) = prior {
        check(expected == hash, "idempotency_conflict")?;
        return super::receipts::hydrate(db, decode(&receipt)?);
    }
    let relation = parent(db, session, sender, input)?;
    let current_epoch = epoch(db, session)?;
    if matches!(input.instruction, InstructionBody::Transfer(_)) {
        check(
            matches!(sender, InstructionSender::User { .. })
                && input.mode == InstructionMode::Steer
                && input.expected_control_epoch.is_some(),
            "owner_authority_required",
        )?;
    }
    check(
        input
            .expected_control_epoch
            .is_none_or(|e| e == current_epoch),
        "control_epoch_conflict",
    )?;
    if let InstructionBody::Text(body) = &input.instruction {
        check(
            !body.text.trim().is_empty() || !body.attachment_refs.is_empty(),
            "instruction_required",
        )?;
    }
    let anchor = capture(db, session, transport_turn)?;
    let task = anchor.get("task_id").unwrap_or(&Value::Null).as_str();
    let turn = anchor.get("turn_id").unwrap_or(&Value::Null).as_str();
    let status = match input.mode {
        InstructionMode::Queue if task.is_some() => "waiting_for_task",
        InstructionMode::Queue if turn.is_some() => "waiting_for_turn",
        InstructionMode::Queue | InstructionMode::Steer => "pending_safe_point",
    };
    let id = stable_id("INSTRUCTION", session, &input.idempotency_key)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut receipt = json!({"ok":true,"instruction_id":id,"idempotency_key":input.idempotency_key,"target_session_id":session,"sender":sender,"relation":relation,"mode":input.mode,"status":status,"anchor":anchor,"control_epoch":current_epoch,"received_at":now,"operation_ids":[]});
    db.execute("INSERT INTO wm_instructions(id,session_id,operation_key,payload_hash,sender_json,input_json,anchor_json,mode,status,anchor_task_id,anchor_turn_id,receipt_json,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![id,session,input.idempotency_key,hash,encode(sender)?,encode(input)?,encode(&anchor)?,if input.mode==InstructionMode::Steer {"steer"}else{"queue"},status,task,turn,encode(&receipt)?,now]).map_err(sql)?;
    set(&mut receipt, "received_seq", json!(db.last_insert_rowid()))?;
    authority::index_targets(db, &id, &input.instruction)?;
    if input.mode == InstructionMode::Steer {
        db.execute("INSERT INTO wm_inboxes(session_id,control_epoch) VALUES(?1,1) ON CONFLICT(session_id) DO UPDATE SET control_epoch=control_epoch+1", [session]).map_err(sql)?;
    }
    set(&mut receipt, "control_epoch", json!(epoch(db, session)?))?;
    if status == "waiting_for_task" && matches!(input.instruction, InstructionBody::Text(_)) {
        drafts::placeholder(db, session, &id, task, input, &mut receipt)?;
    }
    event(db, session, &id, &mut receipt)?;
    super::receipts::hydrate(db, receipt)
}

fn parent(
    db: &Connection,
    target: &str,
    sender: &InstructionSender,
    input: &InstructionInput,
) -> Result<Value> {
    let InstructionSender::Parent {
        session_id,
        turn_id,
    } = sender
    else {
        check(
            input.relation_id.is_none() && input.relation_epoch.is_none(),
            "sender_runtime_owned",
        )?;
        return Ok(Value::Null);
    };
    let admitted: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND turn_id=?2)",
            params![session_id, turn_id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(admitted, "parent_instruction_authority_invalid")?;
    effect_fence(db, session_id)?;
    let relation: Option<String> = db.query_row("SELECT relation_id FROM btcc_session_relations WHERE parent_session_id=?1 AND child_session_id=?2",params![session_id,target],|r|r.get(0)).optional().map_err(sql)?;
    let relation = relation.ok_or_else(|| error("parent_conflict"))?;
    check(
        input.relation_id.as_ref() == Some(&relation),
        "parent_conflict",
    )?;
    db.execute("INSERT OR IGNORE INTO wm_parent_authority(child_session_id,parent_session_id,relation_id) VALUES(?1,?2,?3)",params![target,session_id,relation]).map_err(sql)?;
    let (parent, id, epoch):(String,String,u64)=db.query_row("SELECT parent_session_id,relation_id,epoch FROM wm_parent_authority WHERE child_session_id=?1",[target],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
    check(parent == *session_id && id == relation, "parent_conflict")?;
    check(
        input.relation_epoch == Some(epoch),
        "relation_epoch_conflict",
    )?;
    Ok(json!({"relation_id":relation,"epoch":epoch}))
}

fn capture(db: &Connection, session: &str, transport_turn: Option<String>) -> Result<Value> {
    let task: Option<String> = db
        .query_row(
            "SELECT COALESCE(s.current_task_id,(SELECT json_extract(d.packet_json,'$.task_id') FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) JOIN wm_tasks t ON t.id=json_extract(d.packet_json,'$.task_id') WHERE r.child_session_id=s.session_id AND t.status NOT IN ('completed','cancelled')),(SELECT json_extract(d.packet_json,'$.task_id') FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) JOIN wm_tasks t ON t.id=json_extract(d.packet_json,'$.task_id') WHERE r.parent_session_id=s.session_id AND t.status NOT IN ('completed','cancelled') ORDER BY r.ordinal DESC LIMIT 1)) FROM wm_sessions s WHERE s.session_id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?
        .flatten();
    let turn: Option<String> = transport_turn.or(db.query_row("SELECT t.turn_id FROM btcc_turns t LEFT JOIN wm_inboxes i ON i.session_id=t.session_id WHERE t.session_id=?1 AND t.semantic_state='admitted' AND (t.turn_id IS NOT i.sealed_turn_id OR i.boundary_kind='wait') ORDER BY t.rowid DESC LIMIT 1", [session], |r|r.get(0)).optional().map_err(sql)?);
    let boundary: u64 = db
        .query_row(
            "SELECT boundary_seq FROM wm_inboxes WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?
        .unwrap_or_default();
    let attempt: Option<String> = db
        .query_row(
            "SELECT id FROM wm_attempts WHERE task_id=?1 AND status='running'",
            [&task],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(
        json!({"kind":if task.is_some(){"task"}else{"turn"},"task_id":task,"turn_id":turn,"attempt_id":attempt,"boundary_seq":boundary}),
    )
}
