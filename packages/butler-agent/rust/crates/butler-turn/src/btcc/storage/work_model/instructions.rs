//! Instruction, receipt and boundary mutations share the Work transaction lane.
use super::*;
mod admission;
mod authority;
pub(super) mod delivery;
pub(super) mod drafts;
mod receipts;

pub(in crate::btcc::storage::work_model) fn initial_child(
    db: &Connection,
    input: &crate::btcc::SubsessionCreate,
) -> Result<()> {
    let envelope = &input.dispatch_intent.envelope;
    admission::admit(
        db,
        &input.child_session_id,
        &InstructionSender::Parent {
            session_id: input.parent_session_id.clone(),
            turn_id: input.parent_turn_id.clone(),
        },
        &InstructionInput {
            idempotency_key: envelope.message.id.clone(),
            mode: InstructionMode::Steer,
            instruction: InstructionBody::Text(InstructionText {
                text: envelope.message.text.clone(),
                attachment_refs: vec![],
            }),
            expected_control_epoch: None,
            relation_id: Some(input.relation_id.clone()),
            relation_epoch: Some(1),
        },
        Some(input.child_turn_id.clone()),
    )?;
    Ok(())
}

impl WorkModelRepository {
    pub async fn pending_session_instructions(
        &self,
        session: String,
        after: u64,
    ) -> Result<Vec<Value>> {
        self.lane(move |db| {
            let mut statement = db.prepare_cached("SELECT receipt_json FROM wm_instructions WHERE session_id=?1 AND status='pending_safe_point' AND seq>?2 ORDER BY seq LIMIT 50").map_err(sql)?;
            statement.query_map(params![session,after],|r|r.get::<_,String>(0)).map_err(sql)?.map(|r|decode(&r.map_err(sql)?)).collect()
        }).await
    }
    pub async fn instruction_authority(&self, session: String) -> Result<Value> {
        self.lane(move |db| {
            let parent: Option<(String,String,u64)> = db.query_row("SELECT parent_session_id,relation_id,epoch FROM wm_parent_authority WHERE child_session_id=?1",[&session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sql)?;
            Ok(json!({"control_epoch":epoch(db,&session)?,"relation_id":parent.as_ref().map(|p|&p.1),"relation_epoch":parent.as_ref().map(|p|p.2),"parent_session_id":parent.as_ref().map(|p|&p.0)}))
        }).await
    }
    pub async fn instruction_body(&self, session: String, key: String) -> Result<InstructionBody> {
        self.lane(move |db| {
            let input: String = db.query_row("SELECT input_json FROM wm_instructions WHERE session_id=?1 AND operation_key=?2",params![session,key],|r|r.get(0)).map_err(sql)?;
            Ok(decode::<InstructionInput>(&input)?.instruction)
        }).await
    }
    pub async fn pending_instruction_dispatches(&self, after: u64) -> Result<Vec<Value>> {
        self.lane(move |db| {
            let mut statement = db.prepare_cached("SELECT i.receipt_json FROM wm_instructions i JOIN btcc_session_relations r ON r.child_session_id=i.session_id WHERE i.status='pending_safe_point' AND i.seq>?1 ORDER BY i.seq LIMIT 50").map_err(sql)?;
            statement.query_map([after],|r|r.get::<_,String>(0)).map_err(sql)?.map(|r|decode(&r.map_err(sql)?)).collect()
        }).await
    }
    pub async fn pending_instruction_operations(
        &self,
        session: String,
    ) -> Result<Vec<(String, InstructionOperations)>> {
        self.lane(move |db| {
            let tx = db.transaction().map_err(sql)?;
            delivery::release(&tx,&session)?;
            let result = {
                let mut statement = tx.prepare_cached("SELECT id,input_json FROM wm_instructions WHERE session_id=?1 AND status='pending_safe_point' ORDER BY seq LIMIT 50").map_err(sql)?;
                let rows = statement.query_map([session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?;
                let mut result = Vec::new();
                for row in rows { let (id,input) = row.map_err(sql)?; if let InstructionBody::Operations(batch)=decode::<InstructionInput>(&input)?.instruction { result.push((id,batch)); } }
                result
            };
            tx.commit().map_err(sql)?;
            Ok(result)
        }).await
    }
    pub async fn instruction_receipt(&self, session: String, key: String) -> Result<Value> {
        self.lane(move |db| {
            let receipt:String=db.query_row("SELECT receipt_json FROM wm_instructions WHERE session_id=?1 AND operation_key=?2",params![session,key],|r|r.get(0)).map_err(sql)?;
            receipts::hydrate(db,decode(&receipt)?)
        }).await
    }
    pub async fn interrupted_boundary(&self, session: String, turn: String) -> Result<Value> {
        self.lane(move |db| {
            let tx = db.transaction().map_err(sql)?;
            tx.execute(
                "INSERT OR IGNORE INTO wm_interrupted_turns VALUES(?1,?2)",
                params![turn, session],
            )
            .map_err(sql)?;
            delivery::release(&tx, &session)?;
            tx.commit().map_err(sql)?;
            Ok(json!({"ok":true}))
        })
        .await
    }
    pub async fn instruction_dispatch(&self, session: String, key: String) -> Result<Value> {
        self.lane(move |db| {
            let tx=db.transaction().map_err(sql)?;
            delivery::release(&tx,&session)?;
            let ready: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE session_id=?1 AND operation_key=?2 AND status='pending_safe_point')",params![session,key],|r|r.get(0)).map_err(sql)?;
            let bypass: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE session_id=?1 AND operation_key=?2 AND mode='steer')",params![session,key],|r|r.get(0)).map_err(sql)?;
            let active: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND semantic_state='admitted' AND suspension_reason IS NULL AND turn_id NOT IN (SELECT turn_id FROM wm_interrupted_turns WHERE session_id=?1))",[&session],|r|r.get(0)).map_err(sql)?;
            let admitting: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions i WHERE i.session_id=?1 AND i.operation_key=?2 AND i.anchor_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM btcc_turns t WHERE t.turn_id=i.anchor_turn_id))",params![session,key],|r|r.get(0)).map_err(sql)?;
            let typed: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE session_id=?1 AND operation_key=?2 AND json_type(input_json,'$.instruction.text') IS NULL)",params![session,key],|r|r.get(0)).map_err(sql)?;
            tx.commit().map_err(sql)?;
            Ok(json!({"dispatch":ready && !active && !admitting,"bypass":bypass,"idle_control":ready && !active && !admitting && typed}))
        }).await
    }
    pub async fn instruct(
        &self,
        session: String,
        sender: InstructionSender,
        input: InstructionInput,
        transport_turn: Option<String>,
    ) -> Result<Value> {
        self.lane(move |db| {
            let tx = db.transaction().map_err(sql)?;
            let result = admission::admit(&tx, &session, &sender, &input, transport_turn)?;
            tx.commit().map_err(sql)?;
            Ok(result)
        })
        .await
    }

    pub async fn instructions(&self, session: String, after: u64) -> Result<Value> {
        self.lane(move |db| {
            let mut statement = db.prepare_cached("SELECT receipt_json FROM wm_instructions WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 50").map_err(sql)?;
            let rows = statement.query_map(params![session,after], |r|r.get::<_,String>(0)).map_err(sql)?;
            let receipts = rows.map(|r|receipts::hydrate(db,decode::<Value>(&r.map_err(sql)?)?)).collect::<Result<Vec<_>>>()?;
            let epoch = epoch(db, &session)?;
            Ok(json!({"instructions":receipts,"control_epoch":epoch,"next_cursor":receipts.last().and_then(|r| r.get("received_seq"))}))
        }).await
    }

    pub async fn instruction_safe_point(
        &self,
        session: String,
        turn: String,
        after: u64,
        verified: std::collections::HashMap<String, Option<String>>,
    ) -> Result<Value> {
        self.lane(move |db| {
            let tx = db.transaction().map_err(sql)?;
            let result = delivery::drain(&tx, &session, &turn, after, &verified)?;
            tx.commit().map_err(sql)?;
            Ok(result)
        })
        .await
    }

    pub async fn seal_instructions(
        &self,
        session: String,
        turn: String,
        after: u64,
        final_answer: bool,
    ) -> Result<bool> {
        self.lane(move |db| {
            let tx = db.transaction().map_err(sql)?;
            delivery::release(&tx, &session)?;
            let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE session_id=?1 AND ((status='pending_safe_point' AND (mode='steer' OR anchor_task_id IS NOT NULL OR json_type(input_json,'$.instruction.text') IS NULL OR operation_key=(SELECT original_message_id FROM btcc_turns WHERE turn_id=?3) OR 'instruction-message:'||id=(SELECT original_message_id FROM btcc_turns WHERE turn_id=?3))) OR (status='delivered' AND seq>?2 AND delivered_turn_id=?3)))", params![session,after,turn], |r|r.get(0)).map_err(sql)?;
            if pending { return Ok(false); }
            tx.execute("INSERT INTO wm_inboxes(session_id,sealed_turn_id,boundary_kind,sealed_seq,boundary_seq) VALUES(?1,?2,?3,?4,1) ON CONFLICT(session_id) DO UPDATE SET sealed_turn_id=?2,boundary_kind=?3,sealed_seq=?4,boundary_seq=boundary_seq+1", params![session,turn,if final_answer {"answer"} else {"wait"},after]).map_err(sql)?;
            tx.commit().map_err(sql)?;
            Ok(true)
        }).await
    }
}

pub(super) fn epoch(db: &Connection, session: &str) -> Result<u64> {
    Ok(db
        .query_row(
            "SELECT control_epoch FROM wm_inboxes WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?
        .unwrap_or_default())
}

pub(super) fn effect_fence(db: &Connection, session: &str) -> Result<()> {
    let fenced: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM wm_inboxes WHERE session_id=?1 AND control_epoch<>observed_epoch)",[&session],|r|r.get(0)).map_err(sql)?;
    check(!fenced, "instruction_response_fenced")
}

fn event(db: &Connection, session: &str, id: &str, receipt: &mut Value) -> Result<()> {
    let mut delta = receipts::record(db, id, receipt)?;
    db.execute("INSERT INTO wm_audit(scope_id,session_id,instruction_id,operation_key,payload_hash,request_json,result_json,created_at) VALUES(?1,?1,?2,?3,?4,?5,?5,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![session,id,format!("{id}:{}",receipt.get("status").unwrap_or(&Value::Null)),fingerprint(&delta)?,encode(&delta)?]).map_err(sql)?;
    let seq = db.last_insert_rowid();
    set(receipt, "event_seq", json!(seq))?;
    set(&mut delta, "event_seq", json!(seq))?;
    db.execute(
        "UPDATE wm_instructions SET receipt_json=?1,status=?2 WHERE id=?3",
        params![
            encode(&delta)?,
            receipt.get("status").unwrap_or(&Value::Null).as_str(),
            id
        ],
    )
    .map_err(sql)?;
    db.execute("INSERT INTO wm_outbox VALUES(?1,?2)", params![seq,encode(&json!({"kind":"instruction.updated","event_seq":seq,"session_id":session,"instruction_id":id,"receipt":delta}))?]).map_err(sql)?;
    if let Some(plan) = reads::plan(db, session)? {
        db.execute("UPDATE wm_plans SET event_seq=?1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope_id=?2 AND id=?3",params![seq,plan.scope_id,plan.id]).map_err(sql)?;
    }
    Ok(())
}

pub(super) fn task_boundary(db: &Connection, task: &str) -> Result<()> {
    let mut statement = db.prepare_cached("SELECT DISTINCT session_id FROM wm_instructions WHERE anchor_task_id=?1 AND status='waiting_for_task'").map_err(sql)?;
    let sessions = statement
        .query_map([task], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    for session in sessions {
        delivery::release(db, &session)?;
    }
    Ok(())
}

pub(in crate::btcc::storage) fn turn_boundary(
    db: &Connection,
    turn: &str,
    final_answer: bool,
) -> Result<()> {
    let enabled: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='wm_mode')",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !enabled {
        return Ok(());
    }
    let session: String = db
        .query_row(
            "SELECT session_id FROM btcc_turns WHERE turn_id=?1",
            [turn],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let sealed: Option<u64> = db.query_row("SELECT sealed_seq FROM wm_inboxes WHERE session_id=?1 AND sealed_turn_id=?2 AND boundary_kind='answer'",params![session,turn],|r|r.get(0)).optional().map_err(sql)?;
    if final_answer && let Some(after) = sealed {
        let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE session_id=?1 AND seq<=?2 AND status='pending_safe_point')",params![session,after],|r|r.get(0)).map_err(sql)?;
        check(!pending, "instruction_boundary_conflict")?;
        delivery::answer(db, &session, turn, after)?;
    }
    delivery::release(db, &session)?;
    db.execute("INSERT INTO wm_audit(scope_id,session_id,instruction_id,operation_key,payload_hash,request_json,result_json,created_at) VALUES(?1,?1,?2,?3,'boundary','{}','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![session,turn,format!("{turn}:boundary")]).map_err(sql)?;
    let seq = db.last_insert_rowid();
    db.execute("INSERT INTO wm_outbox VALUES(?1,?2)",params![seq,encode(&json!({"kind":"session.control_changed","session_id":session,"event_seq":seq,"control_epoch":epoch(db,&session)?,"boundary":"settled"}))?]).map_err(sql)?;
    Ok(())
}

pub(super) fn authorize_operation(db: &Connection, session: &str, id: &str) -> Result<()> {
    let turn: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND session_id=?2)",
            params![id, session],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let delivered: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE id=?1 AND session_id=?2 AND status IN ('delivered','applied','needs_input'))",params![id,session],|r|r.get(0)).map_err(sql)?;
    check(turn || delivered, "instruction_scope_invalid")
}

pub(super) fn acknowledge_operation(
    db: &Connection,
    session: &str,
    request: &WorkModelRequest,
    result: &Value,
) -> Result<()> {
    let prior: Option<(String,String)>=db.query_row("SELECT i.id,i.receipt_json FROM wm_instructions i WHERE i.session_id=?2 AND i.status IN ('delivered','applied') AND (i.id=?1 OR (i.delivered_turn_id=?1 AND EXISTS(SELECT 1 FROM btcc_turns t WHERE t.turn_id=?1 AND t.original_message_id IN (i.operation_key,'instruction-message:'||i.id)))) ORDER BY i.seq DESC LIMIT 1",params![request.instruction_id,session],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    if let Some((id, prior)) = prior {
        let mut receipt: Value = decode(&prior)?;
        set(
            &mut receipt,
            "operation_ids",
            result
                .get("operation_ids")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        set(&mut receipt, "status", json!("applied"))?;
        set(&mut receipt, "result", result.clone())?;
        receipts::acknowledge(db, session, &id, &mut receipt, result)?;
    }
    Ok(())
}
