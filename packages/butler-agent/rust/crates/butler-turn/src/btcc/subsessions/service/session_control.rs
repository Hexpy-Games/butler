//! Parent-owned native controls, with durable receipts and control-epoch CAS.
use super::*;
use butler_core::json::at;
use butler_work::store;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionControlRequest {
    #[serde(skip)]
    pub parent_session_id: String,
    pub target_session_id: String,
    pub mode: String,
    pub instruction: Instruction,
    pub expected_control_epoch: i64,
    pub idempotency_key: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Instruction {
    Text {
        text: String,
        #[serde(default)]
        attachment_refs: Vec<String>,
    },
    Control {
        control: String,
        hold_id: Option<String>,
    },
}

impl SubsessionService {
    pub async fn observe_holds(
        &self,
        session: &str,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), BtccError> {
        let storage = self.repository.storage();
        let mut changes = storage.subscribe_changes();
        loop {
            let session = session.to_owned();
            let held = storage
                .work_model_read(move |db| {
                    Ok(!store::active_session_holds(db, &session)?.is_empty())
                })
                .await
                .map_err(BtccError::from)?;
            if !held {
                return Ok(());
            }
            tokio::select! {
                ()=cancellation.cancelled()=>return Ok(()),
                changed=changes.changed()=>if changed.is_err() { return Err(error(BtccCode::SubsessionPersistFailed)) },
            }
        }
    }

    pub async fn session_control(
        &self,
        request: SessionControlRequest,
    ) -> Result<Value, BtccError> {
        let child = self.control_child(&request).await?;
        let Some(child) =
            child.filter(|child| child.parent_session_id == request.parent_session_id)
        else {
            return Ok(
                json!({"ok":false,"error":{"code":"parent_control_forbidden","message":store::parent_control_forbidden(&request.target_session_id)}}),
            );
        };
        let for_enqueue = child.clone();
        let control_name = match &request.instruction {
            Instruction::Control { control, .. } => Some(control.clone()),
            Instruction::Text { .. } => None,
        };
        let target = request.target_session_id.clone();
        let input = serde_json::to_value(&request)
            .map_err(|e| error(BtccCode::SubsessionIdentityInvalid).with_source(e))?;
        let receipt=self.repository.storage().work_model_write(move |tx| {
            tx.execute_batch("SAVEPOINT session_control")?;
            let result = (|| {
            let ctx=admission::context();
            let parent_tier: Option<i64>=tx.query_row(crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_SESSION_CONTROL_1,[&request.parent_session_id],|r|r.get(0)).optional()?;
            let parent_tier=parent_tier.ok_or(store::Error::NotFound)?;
            if !matches!(request.mode.as_str(), "queue" | "steer") { return Err(store::Error::Invalid("mode must be queue or steer")) }
            if parent_tier!=2 { return Err(store::Error::Invalid("session_control requires Tier 2")) }
            let key=format!("session_control:{}:{}",request.parent_session_id,request.idempotency_key);
            let prior:Option<String>=tx.query_row(crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_SESSION_CONTROL_2,[&key],|r|r.get(0)).optional()?;
            if let Some(prior)=prior {
                let prior:Value=serde_json::from_str(&prior)?;
                return if at(&prior, "/input")==&input { Ok(at(&prior, "/receipt").clone()) } else { Ok(store::refusal("conflict",store::conflict("idempotency key reused with different input"))) };
            }
            let current=store::control_epoch(tx,&request.target_session_id)?;
            if current!=request.expected_control_epoch {
                return Ok(json!({"ok":false,"error":{"code":"conflict","message":store::conflict("control epoch changed"),"current":{"control_epoch":current}}}));
            }
            let receipt=match &request.instruction {
                Instruction::Text { text,.. } if !text.trim().is_empty() => store::admit_instruction(tx,&ctx,&store::SessionInstruction {
                    target:&request.target_session_id,sender:json!({"parent":{"session_id":request.parent_session_id,"relation_id":child.relation_id,"relation_epoch":0}}),
                    mode:&request.mode,body:serde_json::to_value(&request.instruction)?,idempotency_key:&key,
                    expected_control_epoch:current,anchor_task:&child.task_id })?,
                Instruction::Control { control: kind,hold_id } => match kind.as_str() {
                    "pause"|"stop" => store::hold_session(tx,&ctx,&request.target_session_id,kind,&request.parent_session_id)?,
                    "resume" => {
                        let id=hold_id.as_deref().ok_or(store::Error::Invalid("hold_id required for resume"))?;
                        let owned:bool=tx.query_row(crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_SESSION_CONTROL_3,params![id,request.target_session_id,request.parent_session_id],|_|Ok(true)).optional()?.unwrap_or(false);
                        if !owned { return Err(store::Error::Invalid("hold belongs to another owner")) }
                        store::release_session_hold(tx,&ctx,id,current)?
                    }
                    _=>return Err(store::Error::Invalid("unknown control")),
                },
                Instruction::Text { .. }=>return Err(store::Error::Invalid("instruction text required")),
            };
            store::record_intent(tx,&ctx,&key,"session_control",&json!({"input":input,"receipt":receipt}))?;
            store::mark_intent_applied(tx,&ctx,&key,0)?;
            Ok(receipt)
            })();
            match result {
                Ok(receipt) => {tx.execute_batch("RELEASE session_control")?; Ok(receipt)},
                Err(error) => {
                    tx.execute_batch("ROLLBACK TO session_control; RELEASE session_control")?;
                    store::from_error(&error).ok_or(error)
                }
            }
        }).await.map_err(BtccError::from)?;
        if at(&receipt, "/ok") == true {
            self.notify_execution_changed(&target).await?;
            if control_name.as_deref() == Some("stop") {
                self.enqueue_cancel(&for_enqueue, &receipt.to_string())
                    .await?;
            } else if (control_name.is_none() || control_name.as_deref() == Some("resume"))
                && !self.child_turn_running(&target).await?
            {
                self.release_pending_direction(&target).await?;
            }
        }
        Ok(receipt)
    }
    async fn control_child(
        &self,
        request: &SessionControlRequest,
    ) -> Result<Option<crate::btcc::Child>, BtccError> {
        self.repository
            .by_child(request.target_session_id.clone())
            .await
            .map_err(BtccError::from)
    }
}
