//! Session instructions and composable holds share the writer's safe point.
use super::*;
use rusqlite::params;

pub struct Instruction<'a> {
    pub target: &'a str,
    pub sender: Value,
    pub mode: &'a str,
    pub body: Value,
    pub idempotency_key: &'a str,
    pub expected_control_epoch: i64,
    pub anchor_task: &'a str,
}

pub fn admit(tx: &Transaction<'_>, ctx: &Context, input: &Instruction<'_>) -> Result<Value> {
    if !matches!(input.mode, "queue" | "steer") || input.idempotency_key.is_empty() {
        return Err(Error::Invalid(
            "instruction mode and idempotency key required",
        ));
    }
    let mut content = json!({"target":input.target,"sender":input.sender,"mode":input.mode,
        "body":input.body,"anchor_task":input.anchor_task});
    match one(tx, sql::CONTROL_KEY, [input.idempotency_key]) {
        Ok(row) => {
            let mut stored: Value =
                serde_json::from_str(&tool_read::body(tx, text(&row, "body_ref")?)?)?;
            stored
                .as_object_mut()
                .ok_or(Error::Invalid("instruction content"))?
                .remove("control_epoch");
            if stored != content {
                return Err(Error::Invalid("idempotency_conflict"));
            }
            return receipt(tx, row);
        }
        Err(Error::NotFound) => {}
        Err(error) => return Err(error),
    }
    advance_epoch(tx, input.target, input.expected_control_epoch)?;
    content["control_epoch"] = json!(input.expected_control_epoch + 1);
    persist_instruction(tx, ctx, input, &content)
}

fn persist_instruction(
    tx: &Transaction<'_>,
    ctx: &Context,
    input: &Instruction<'_>,
    content: &Value,
) -> Result<Value> {
    let id =
        crate::work_ids::IdGenerator::global_next(crate::work_ids::IdKind::Operation, ctx.now)?;
    let body = put_body(tx, &content.to_string())?;
    let seq: i64 = tx.query_row(sql::CONTROL_SEQUENCE, [], |r| r.get(0))?;
    let status = if input.mode == "queue" {
        "waiting_for_task"
    } else {
        "pending_safe_point"
    };
    tx.execute(
        sql::CONTROL_INSERT,
        params![
            id,
            input.idempotency_key,
            input.target,
            input.sender.to_string(),
            input.mode,
            body,
            input.anchor_task,
            seq,
            status
        ],
    )?;
    event(tx, ctx, "instruction", &id, 0, "admit")?;
    receipt(tx, one(tx, sql::CONTROL_KEY, [input.idempotency_key])?)
}

fn receipt(db: &Connection, row: Value) -> Result<Value> {
    let content: Value = serde_json::from_str(&tool_read::body(db, text(&row, "body_ref")?)?)?;
    Ok(
        json!({"ok":true,"instruction_id":row["id"],"control_epoch":content["control_epoch"],
        "status":"accepted"}),
    )
}

pub fn epoch(db: &Connection, session: &str) -> Result<i64> {
    one(db, tiers::sql::SESSION, [session])?["control_epoch"]
        .as_i64()
        .ok_or(Error::Invalid("control_epoch"))
}

pub fn advance_epoch(tx: &Transaction<'_>, session: &str, expected: i64) -> Result<i64> {
    let current = epoch(tx, session)?;
    if current != expected {
        return Err(Error::Conflict {
            current: json!({"control_epoch":current}),
        });
    }
    tx.execute(sql::CONTROL_EPOCH, params![session, expected])?;
    Ok(expected + 1)
}

pub fn next_pending(db: &Connection, session: &str, steer_only: bool) -> Result<Vec<Value>> {
    let mut pending = rows(db, sql::CONTROL_NEXT, params![session, steer_only])?;
    for row in &mut pending {
        let content = tool_read::body(db, text(row, "body_ref")?)?;
        // Imported instructions may contain the original plain direction text.
        row["content"] = serde_json::from_str(&content).unwrap_or(json!({"body":{"text":content}}));
    }
    Ok(pending)
}

pub fn mark_delivered(tx: &Transaction<'_>, ctx: &Context, id: &str, status: &str) -> Result<()> {
    if tx.execute(sql::CONTROL_STATUS, params![id, "delivered", status])? > 0 {
        event(tx, ctx, "instruction", id, 0, "delivered")?;
    }
    Ok(())
}

pub fn mark_applied(tx: &Transaction<'_>, ctx: &Context, id: &str) -> Result<()> {
    if tx.execute(sql::CONTROL_STATUS, params![id, "applied", "delivered"])? > 0 {
        event(tx, ctx, "instruction", id, 0, "applied")?;
    }
    Ok(())
}

pub fn active_holds(db: &Connection, session: &str) -> Result<Vec<Value>> {
    rows(db, sql::HOLDS, [session])
}

pub fn hold(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    kind: &str,
    owner: &str,
) -> Result<Value> {
    if !matches!(kind, "pause" | "stop") {
        return Err(Error::Invalid("hold kind"));
    }
    let epoch = advance_epoch(tx, session, epoch(tx, session)?)?;
    let id =
        crate::work_ids::IdGenerator::global_next(crate::work_ids::IdKind::Operation, ctx.now)?;
    tx.execute(sql::HOLD_INSERT, params![id, session, owner, kind])?;
    let state = if kind == "stop" {
        "stopping"
    } else {
        "pausing"
    };
    tx.execute(sql::CONTROL_STATE, params![session, state])?;
    event(tx, ctx, "session", session, epoch, "hold")?;
    Ok(json!({"ok":true,"hold_id":id,"control_epoch":epoch,"status":"accepted"}))
}

pub fn release(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_epoch: i64,
) -> Result<Value> {
    let row = one(tx, sql::CONTROL_HOLD, [id])?;
    let session = text(&row, "target")?;
    let epoch = advance_epoch(tx, session, expected_epoch)?;
    tx.execute(sql::HOLD_RELEASE, params![id, ctx.now])?;
    let holds = active_holds(tx, session)?;
    let state = if holds.iter().any(|h| h["kind"] == "stop") {
        "stopping"
    } else if holds.is_empty() {
        "running"
    } else {
        "pausing"
    };
    tx.execute(sql::CONTROL_STATE, params![session, state])?;
    event(tx, ctx, "session", session, epoch, "resume")?;
    let mut receipt = json!({"ok":true,"hold_id":id,"control_epoch":epoch,"status":"accepted"});
    if holds.is_empty()
        && row["kind"] == "stop"
        && let Some(task) = one(tx, tiers::sql::SESSION, [session])?["current_task_id"].as_str()
    {
        receipt["instruction_id"] =
            resume_instruction(tx, ctx, session, task, id, text(&row, "owner")?, epoch)?;
    }
    Ok(receipt)
}

fn resume_instruction(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    task: &str,
    hold: &str,
    owner: &str,
    epoch: i64,
) -> Result<Value> {
    if let Some(pending) = next_pending(tx, session, false)?.first() {
        return Ok(pending["id"].clone());
    }
    let input = Instruction {
        target: session,
        sender: json!({"parent":{"session_id":owner}}),
        mode: "queue",
        body: json!({"text":"Resume the assigned Task from its retained checkpoint."}),
        idempotency_key: &format!("resume:{hold}:{epoch}"),
        expected_control_epoch: epoch - 1,
        anchor_task: task,
    };
    let content = json!({"target":session,"sender":input.sender,"mode":"queue","body":input.body,"anchor_task":task,"control_epoch":epoch});
    Ok(persist_instruction(tx, ctx, &input, &content)?["instruction_id"].clone())
}
