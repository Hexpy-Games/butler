use super::*;

pub(super) fn release(db: &Connection, session: &str) -> Result<()> {
    let mut statement = db.prepare_cached("SELECT i.id,i.receipt_json,COALESCE(t.status,CASE WHEN b.turn_id IN (SELECT turn_id FROM wm_interrupted_turns WHERE session_id=?1) THEN 'interrupted' ELSE b.semantic_state END,'pending') FROM wm_instructions i LEFT JOIN wm_tasks t ON t.id=i.anchor_task_id LEFT JOIN btcc_turns b ON b.turn_id=i.anchor_turn_id WHERE i.session_id=?1 AND i.status IN ('waiting_for_task','waiting_for_turn') AND (t.status IN ('completed','cancelled') OR (i.anchor_task_id IS NULL AND (b.semantic_state IN ('delivered','delivery_committed','cancelled') OR b.turn_id IN (SELECT turn_id FROM wm_interrupted_turns WHERE session_id=?1)))) ORDER BY i.seq LIMIT 50").map_err(sql)?;
    let rows = statement
        .query_map([session], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (id, receipt, state) = row.map_err(sql)?;
        let status = match state.as_str() {
            "completed" | "delivered" | "delivery_committed" | "interrupted" => {
                "pending_safe_point"
            }
            "cancelled" => "needs_input",
            _ => continue,
        };
        let mut receipt: Value = decode(&receipt)?;
        set(&mut receipt, "status", json!(status))?;
        if state == "interrupted" {
            set(&mut receipt, "boundary_reason", json!("turn_interrupted"))?;
        }
        if state == "cancelled" {
            set(
                &mut receipt,
                "error",
                json!({"code":"anchor_cancelled","message":"Choose a new boundary explicitly."}),
            )?;
        }
        event(db, session, &id, &mut receipt)?;
    }
    Ok(())
}

pub(super) fn drain(
    db: &Connection,
    session: &str,
    turn: &str,
    after: u64,
    verified: &std::collections::HashMap<String, Option<String>>,
) -> Result<Value> {
    db.execute(
        "DELETE FROM wm_interrupted_turns WHERE turn_id=?1 AND session_id=?2",
        params![turn, session],
    )
    .map_err(sql)?;
    release(db, session)?;
    authority::revalidate(db, session)?;
    db.execute(
        "UPDATE wm_inboxes SET sealed_turn_id=NULL WHERE session_id=?1 AND sealed_turn_id=?2",
        params![session, turn],
    )
    .map_err(sql)?;
    db.execute(
        "UPDATE wm_inboxes SET observed_epoch=control_epoch WHERE session_id=?1",
        [session],
    )
    .map_err(sql)?;
    let mut statement = db.prepare_cached("SELECT id,input_json,receipt_json FROM wm_instructions WHERE session_id=?1 AND ((status='pending_safe_point' AND (mode='steer' OR anchor_task_id IS NOT NULL OR json_type(input_json,'$.instruction.text') IS NULL OR operation_key=(SELECT original_message_id FROM btcc_turns WHERE turn_id=?3) OR 'instruction-message:'||id=(SELECT original_message_id FROM btcc_turns WHERE turn_id=?3))) OR (status IN ('delivered','applied','rejected','superseded','needs_input') AND seq>?2 AND (delivered_turn_id=?3 OR delivered_turn_id IS NULL))) ORDER BY seq LIMIT 50").map_err(sql)?;
    let rows = statement
        .query_map(params![session, after, turn], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    let mut injections = Vec::new();
    let mut latest = after;
    for row in rows {
        let (id, input, receipt) = row.map_err(sql)?;
        if let Some((seq, injection)) = inject(db, session, turn, &id, &input, &receipt, verified)?
        {
            latest = latest.max(seq);
            if let Some(injection) = injection {
                injections.push(injection);
            }
        }
    }
    let more: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE session_id=?1 AND status='pending_safe_point' AND (mode='steer' OR anchor_task_id IS NOT NULL OR json_type(input_json,'$.instruction.text') IS NULL OR operation_key=(SELECT original_message_id FROM btcc_turns WHERE turn_id=?3) OR 'instruction-message:'||id=(SELECT original_message_id FROM btcc_turns WHERE turn_id=?3)))",params![session,latest,turn],|r|r.get(0)).map_err(sql)?;
    Ok(
        json!({"injections":injections,"last_seq":latest,"control_epoch":epoch(db,session)?,"changed":!injections.is_empty(),"has_more":more}),
    )
}

pub(in crate::btcc::storage::work_model) fn apply_batch(
    db: &Connection,
    session: &str,
    id: &str,
    batch_key: &str,
    batch: &InstructionOperations,
) -> Result<Value> {
    check(
        !batch.operations.is_empty() && !batch.reason.trim().is_empty(),
        "operation_reason_required",
    )?;
    check(
        !batch.operations.iter().any(|op| {
            matches!(
                op,
                WorkModelCommand::SessionStop
                    | WorkModelCommand::SessionPause
                    | WorkModelCommand::SessionResume
            )
        }),
        "work_model_controls_unavailable",
    )?;
    let plan = reads::require_plan(db, session)?;
    check(
        plan.graph_revision == batch.expected_graph_revision,
        "graph_revision_conflict",
    )?;
    db.execute_batch("SAVEPOINT instruction_batch")
        .map_err(sql)?;
    let result = (|| {
        let mut results = Vec::new();
        for (index, command) in batch.operations.iter().enumerate() {
            check(
                !matches!(
                    command,
                    WorkModelCommand::Create { .. }
                        | WorkModelCommand::CreateLight { .. }
                        | WorkModelCommand::Activate { .. }
                        | WorkModelCommand::Publish { .. }
                        | WorkModelCommand::Batch { .. }
                ),
                "instruction_operation_unavailable",
            )?;
            let request = WorkModelRequest {
                instruction_id: id.into(),
                idempotency_key: format!("{batch_key}:{index}"),
                expected_graph_revision: Some(reads::require_plan(db, session)?.graph_revision),
                command: command.clone(),
            };
            results.push(super::super::apply(db, session, &request, None)?);
        }
        Ok(
            json!({"operations":results,"operation_ids":(0..batch.operations.len()).map(|i|format!("{batch_key}:{i}")).collect::<Vec<_>>()}),
        )
    })();
    db.execute_batch(if result.is_ok() {
        "RELEASE instruction_batch"
    } else {
        "ROLLBACK TO instruction_batch; RELEASE instruction_batch"
    })
    .map_err(sql)?;
    result
}

pub(super) fn answer(db: &Connection, session: &str, turn: &str, after: u64) -> Result<()> {
    let mut statement = db.prepare_cached("SELECT id,receipt_json FROM wm_instructions WHERE session_id=?1 AND delivered_turn_id=?2 AND seq<=?3 AND status='delivered' AND draft_task_id IS NULL ORDER BY seq").map_err(sql)?;
    let rows = statement
        .query_map(params![session, turn, after], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(sql)?;
    for row in rows {
        let (id, receipt) = row.map_err(sql)?;
        let mut receipt: Value = decode(&receipt)?;
        set(&mut receipt, "status", json!("applied"))?;
        set(&mut receipt, "reply_ref", json!({"turn_id":turn}))?;
        event(db, session, &id, &mut receipt)?;
    }
    Ok(())
}

pub(in crate::btcc::storage::work_model) fn claim_gate(
    db: &Connection,
    session: &str,
) -> Result<()> {
    release(db, session)?;
    let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions i LEFT JOIN wm_tasks t ON t.id=i.draft_task_id WHERE i.session_id=?1 AND (i.status='pending_safe_point' OR (i.status IN ('delivered','needs_input') AND t.status='draft')))",[session],|r|r.get(0)).map_err(sql)?;
    check(!pending, "boundary_instructions_pending")
}

fn apply_control(
    db: &Connection,
    session: &str,
    id: &str,
    body: &InstructionBody,
    verified: &std::collections::HashMap<String, Option<String>>,
    receipt: &mut Value,
) -> Result<()> {
    db.execute_batch("SAVEPOINT typed_instruction")
        .map_err(sql)?;
    let result = match body {
        InstructionBody::Operations(batch) => match verified.get(id).and_then(Option::as_ref) {
            Some(code) => Err(error(code)),
            None => apply_batch(db, session, id, id, batch),
        },
        InstructionBody::Transfer(input) => {
            authority::transfer(db, session, receipt, &input.transfer_parent)
        }
        InstructionBody::Text(_) => Err(error("instruction_invalid")),
    };
    match result {
        Ok(result) => {
            db.execute_batch("RELEASE typed_instruction").map_err(sql)?;
            set(receipt, "status", json!("applied"))?;
            set(
                receipt,
                "operation_ids",
                result
                    .get("operation_ids")
                    .cloned()
                    .unwrap_or_else(|| json!([id])),
            )?;
            set(receipt, "result", result)?;
        }
        Err(failure) => {
            db.execute_batch("ROLLBACK TO typed_instruction; RELEASE typed_instruction")
                .map_err(sql)?;
            set(receipt, "status", json!("rejected"))?;
            set(
                receipt,
                "error",
                json!({"code":failure.code(),"message":failure.message()}),
            )?;
        }
    }
    Ok(())
}

fn deliver(
    db: &Connection,
    session: &str,
    turn: &str,
    id: &str,
    input: InstructionInput,
    mut receipt: Value,
    verified: &std::collections::HashMap<String, Option<String>>,
) -> Result<Option<Value>> {
    let mut injection = None;
    set(&mut receipt, "status", json!("delivered"))?;
    set(&mut receipt, "delivered_turn_id", json!(turn))?;
    db.execute(
        "UPDATE wm_instructions SET delivered_turn_id=?1 WHERE id=?2",
        params![turn, id],
    )
    .map_err(sql)?;
    match input.instruction {
        InstructionBody::Text(body) => {
            let original: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND original_message_id IN (?2,?3))",params![turn,input.idempotency_key,format!("instruction-message:{id}")],|r|r.get(0)).map_err(sql)?;
            // Generated child Turns carry text; their durable attachment refs
            // still need an observation even when the text is already original.
            if !original || !body.attachment_refs.is_empty() {
                injection = Some(json!({"instruction":body}));
            }
        }
        body => {
            apply_control(db, session, id, &body, verified, &mut receipt)?;
            injection = Some(json!({}));
        }
    }
    event(db, session, id, &mut receipt)?;
    if let Some(injection) = &mut injection {
        set(injection, "receipt", super::receipts::hydrate(db, receipt)?)?;
    }
    Ok(injection)
}

fn observe_receipt(
    db: &Connection,
    session: &str,
    turn: &str,
    id: &str,
    receipt: &mut Value,
) -> Result<()> {
    if receipt.get("delivered_turn_id").is_none_or(Value::is_null) && !turn.starts_with("control:")
    {
        db.execute(
            "UPDATE wm_instructions SET delivered_turn_id=?1 WHERE id=?2",
            params![turn, id],
        )
        .map_err(sql)?;
        set(receipt, "delivered_turn_id", json!(turn))?;
        event(db, session, id, receipt)?;
    }
    Ok(())
}

fn defer_text(
    db: &Connection,
    turn: &str,
    id: &str,
    input: &InstructionInput,
    receipt: &Value,
) -> Result<bool> {
    if !matches!(input.instruction, InstructionBody::Text(_)) {
        return Ok(false);
    }
    if turn.starts_with("control:") {
        return Ok(true);
    }
    let anchored_task = receipt
        .get("anchor")
        .and_then(|a| a.get("task_id"))
        .is_some_and(|v| !v.is_null());
    if input.mode == InstructionMode::Queue
        && !anchored_task
        && receipt.get("status").and_then(Value::as_str) == Some("pending_safe_point")
    {
        let original: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND original_message_id IN (?2,?3))",params![turn,input.idempotency_key,format!("instruction-message:{id}")],|r|r.get(0)).map_err(sql)?;
        return Ok(!original);
    }
    Ok(false)
}

fn inject(
    db: &Connection,
    session: &str,
    turn: &str,
    id: &str,
    input: &str,
    receipt: &str,
    verified: &std::collections::HashMap<String, Option<String>>,
) -> Result<Option<(u64, Option<Value>)>> {
    let input: InstructionInput = decode(input)?;
    let mut receipt: Value = decode(receipt)?;
    if defer_text(db, turn, id, &input, &receipt)? {
        return Ok(None);
    }
    let seq = receipt
        .get("received_seq")
        .and_then(Value::as_u64)
        .ok_or_else(|| error("instruction_integrity_error"))?;
    if matches!(
        receipt.get("status").and_then(Value::as_str),
        Some("applied" | "rejected" | "superseded" | "needs_input")
    ) {
        observe_receipt(db, session, turn, id, &mut receipt)?;
        return Ok(Some((
            seq,
            Some(json!({"receipt":super::receipts::hydrate(db,receipt)?})),
        )));
    }
    if matches!(input.instruction, InstructionBody::Operations(_)) && !verified.contains_key(id) {
        return Ok(None);
    }
    Ok(Some((
        seq,
        deliver(db, session, turn, id, input, receipt, verified)?,
    )))
}
