//! Ownership changes and pending typed conflicts live beside the inbox fence.
use super::*;

pub(super) fn transfer(
    db: &Connection,
    child: &str,
    receipt: &Value,
    input: &ParentTransfer,
) -> Result<Value> {
    check(
        receipt
            .get("sender")
            .unwrap_or(&Value::Null)
            .get("kind")
            .unwrap_or(&Value::Null)
            == "user",
        "owner_authority_required",
    )?;
    check(!input.reason.trim().is_empty(), "operation_reason_required")?;
    let (parent, relation): (String, String) = db.query_row(
        "SELECT parent_session_id,relation_id FROM btcc_session_relations WHERE child_session_id=?1",
        [child], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(sql)?;
    db.execute("INSERT OR IGNORE INTO wm_parent_authority(child_session_id,parent_session_id,relation_id) VALUES(?1,?2,?3)", params![child,parent,relation]).map_err(sql)?;
    let prior: u64 = db
        .query_row(
            "SELECT epoch FROM wm_parent_authority WHERE child_session_id=?1",
            [child],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(
        relation == input.relation_id && prior == input.expected_relation_epoch,
        "relation_epoch_conflict",
    )?;
    let admitted: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND turn_id=?2)",
            params![input.parent_session_id, input.parent_turn_id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(admitted, "parent_instruction_authority_invalid")?;
    let child_plan = reads::require_plan(db, child)?;
    let parent_plan = reads::require_plan(db, &input.parent_session_id)?;
    check(
        child_plan.scope_id == parent_plan.scope_id && child_plan.id == parent_plan.id,
        "parent_scope_invalid",
    )?;
    let cycle: bool = db.query_row("WITH RECURSIVE parents(id) AS (SELECT ?1 UNION SELECT r.parent_session_id FROM btcc_session_relations r JOIN parents p ON r.child_session_id=p.id) SELECT EXISTS(SELECT 1 FROM parents WHERE id=?2)",params![input.parent_session_id,child],|r|r.get(0)).map_err(sql)?;
    check(!cycle, "parent_cycle")?;
    let ordinal: u64 = db.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?1",[&input.parent_session_id],|r|r.get(0)).map_err(sql)?;
    db.execute("UPDATE btcc_session_relations SET parent_session_id=?1,parent_turn_id=?2,ordinal=?3 WHERE child_session_id=?4",params![input.parent_session_id,input.parent_turn_id,ordinal,child]).map_err(sql)?;
    db.execute("UPDATE wm_parent_authority SET parent_session_id=?1,epoch=epoch+1 WHERE child_session_id=?2",params![input.parent_session_id,child]).map_err(sql)?;
    db.execute("UPDATE btcc_subsession_delegations SET packet_json=json_set(packet_json,'$.parent_session_id',?1,'$.parent_turn_id',?2) WHERE relation_id=?3",params![input.parent_session_id,input.parent_turn_id,relation]).map_err(sql)?;
    db.execute("UPDATE btcc_subsession_outbox SET parent_session_id=?1,parent_turn_id=?2,input_json=json_set(input_json,'$.parent_session_id',?1,'$.parent_turn_id',?2) WHERE relation_id=?3 AND status='pending'",params![input.parent_session_id,input.parent_turn_id,relation]).map_err(sql)?;
    db.execute("UPDATE wm_inboxes SET control_epoch=control_epoch+1,observed_epoch=control_epoch+1 WHERE session_id=?1",[child]).map_err(sql)?;
    reroute(db, &relation, input, &parent_plan)?;
    revalidate(db, child)?;
    Ok(
        json!({"relation_id":relation,"relation_epoch":prior+1,"parent_session_id":input.parent_session_id,"previous_parent_session_id":parent,"control_epoch":epoch(db,child)?}),
    )
}

pub(super) fn revalidate(db: &Connection, session: &str) -> Result<()> {
    let mut statement = db.prepare_cached("SELECT id,input_json,receipt_json FROM wm_instructions WHERE session_id=?1 AND status IN ('pending_safe_point','waiting_for_task','waiting_for_turn') AND (status='pending_safe_point' OR (json_extract(sender_json,'$.kind')='parent' AND json_extract(input_json,'$.relation_epoch')<>(SELECT epoch FROM wm_parent_authority WHERE child_session_id=?1))) ORDER BY seq LIMIT 50").map_err(sql)?;
    let rows = statement
        .query_map([session], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    let eligible = rows
        .map(|r| {
            let (id, input, receipt) = r.map_err(sql)?;
            Ok((
                id,
                decode::<InstructionInput>(&input)?,
                decode::<Value>(&receipt)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    for (id, input, receipt) in &eligible {
        if receipt
            .get("sender")
            .unwrap_or(&Value::Null)
            .get("kind")
            .unwrap_or(&Value::Null)
            != "parent"
        {
            continue;
        }
        let mut receipt = receipt.clone();
        let valid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_parent_authority WHERE child_session_id=?1 AND parent_session_id=?2 AND relation_id=?3 AND epoch=?4)",params![session,receipt.get("sender").unwrap_or(&Value::Null).get("session_id").unwrap_or(&Value::Null).as_str(),input.relation_id,input.relation_epoch],|r|r.get(0)).map_err(sql)?;
        let conflict: Option<String> = db.query_row("SELECT owner.id FROM wm_instruction_targets a JOIN wm_instruction_targets b ON b.target=a.target JOIN wm_instructions owner ON owner.id=b.instruction_id WHERE a.instruction_id=?1 AND owner.session_id=?2 AND owner.status='pending_safe_point' AND json_extract(owner.sender_json,'$.kind')='user' ORDER BY owner.seq LIMIT 1",params![id,session],|r|r.get(0)).optional().map_err(sql)?;
        if !valid || conflict.is_some() {
            set(
                &mut receipt,
                "status",
                json!(if valid { "superseded" } else { "rejected" }),
            )?;
            set(
                &mut receipt,
                "error",
                json!({"code":if valid {"owner_instruction_conflict"} else {"relation_epoch_conflict"}}),
            )?;
            set(&mut receipt, "source_instruction_id", json!(conflict))?;
            super::drafts::cancel(db, session, &mut receipt, "Parent authority changed")?;
            event(db, session, id, &mut receipt)?;
        }
    }
    Ok(())
}

pub(super) fn index_targets(db: &Connection, id: &str, body: &InstructionBody) -> Result<()> {
    let InstructionBody::Operations(batch) = body else {
        return Ok(());
    };
    for target in batch.operations.iter().flat_map(targets) {
        db.execute(
            "INSERT OR IGNORE INTO wm_instruction_targets VALUES(?1,?2)",
            params![id, target],
        )
        .map_err(sql)?;
    }
    Ok(())
}

fn targets(command: &WorkModelCommand) -> Vec<String> {
    if let WorkModelCommand::Dependencies { add, remove } = command {
        return add
            .iter()
            .chain(remove)
            .flat_map(|edge| [edge.from.clone(), edge.to.clone()])
            .collect();
    }
    let value = serde_json::to_value(command).unwrap_or(Value::Null);
    if let Some(id) = value
        .get("task_id")
        .unwrap_or(&Value::Null)
        .as_str()
        .or(value.get("work_id").unwrap_or(&Value::Null).as_str())
    {
        return vec![id.into()];
    }
    value
        .get("task_ids")
        .unwrap_or(&Value::Null)
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| vec!["graph".into()])
}

fn reroute(
    db: &Connection,
    relation: &str,
    input: &ParentTransfer,
    plan: &reads::Plan,
) -> Result<()> {
    let chat: Option<String> = if plan.owner_session_id == input.parent_session_id {
        db.query_row(
            "SELECT json_extract(context_json,'$.appSessionId') FROM btcc_turns WHERE turn_id=?1",
            [&input.parent_turn_id],
            |r| r.get(0),
        )
        .map_err(sql)?
    } else {
        None
    };
    check(
        plan.owner_session_id != input.parent_session_id || chat.is_some(),
        "parent_app_binding_required",
    )?;
    db.execute("UPDATE btcc_subsession_delegations SET packet_json=json_set(packet_json,'$.parent_chat_id',?1) WHERE relation_id=?2",params![chat,relation]).map_err(sql)?;
    let mut statement = db.prepare_cached("SELECT outbox_id,result_id,message_id,input_json FROM btcc_subsession_outbox WHERE relation_id=?1 AND status='pending'").map_err(sql)?;
    let rows = statement
        .query_map([relation], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (id, result, message, prior) = row.map_err(sql)?;
        let prior: Value = decode(&prior)?;
        let mut body = json!({"route":"steward_queue","text":prior.get("text").unwrap_or(&Value::Null),"model_ref":prior.get("model_ref").unwrap_or(&Value::Null),"reasoning_effort":prior.get("reasoning_effort").unwrap_or(&Value::Null),"timestamp":prior.get("timestamp").unwrap_or(&Value::Null)});
        if let Some(chat) = &chat {
            let access: String = db.query_row("SELECT json_extract(packet_json,'$.access_mode') FROM btcc_subsession_delegations WHERE relation_id=?1",[relation],|r|r.get(0)).map_err(sql)?;
            set(&mut body, "route", json!("butler_app"))?;
            set(&mut body, "relation_id", json!(relation))?;
            set(&mut body, "result_id", json!(result))?;
            set(
                &mut body,
                "parent_session_id",
                json!(input.parent_session_id),
            )?;
            set(&mut body, "parent_turn_id", json!(input.parent_turn_id))?;
            set(&mut body, "parent_chat_id", json!(chat))?;
            set(&mut body, "message_id", json!(message))?;
            set(&mut body, "safe_title", json!("Delegated result"))?;
            set(&mut body, "access_mode", json!(access))?;
        }
        db.execute(
            "UPDATE btcc_subsession_outbox SET input_json=?1 WHERE outbox_id=?2",
            params![encode(&body)?, id],
        )
        .map_err(sql)?;
    }
    Ok(())
}
