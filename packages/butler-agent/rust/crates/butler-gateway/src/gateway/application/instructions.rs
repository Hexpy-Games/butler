//! App queue entries are transport aliases; the BTCC instruction owns delivery.
use super::storage::AppStorageCode;
use super::*;
use rusqlite::params;
use serde_json::json;

impl AppApplication {
    pub(super) async fn send_text_instruction(
        &self,
        chat: &str,
        input: Value,
    ) -> Result<Value, GatewayApplicationError> {
        let validated: butler_turn::btcc::work_model::InstructionInput =
            serde_json::from_value(input.clone())
                .map_err(|_| public(400, "instruction_invalid", "Invalid instruction."))?;
        if validated.relation_id.is_some() || validated.relation_epoch.is_some() {
            return Err(public(
                400,
                "sender_runtime_owned",
                "Sender is set by the runtime.",
            ));
        }
        let enabled = self
            .dependencies
            .session_work_progress
            .work_model(
                crate::gateway::app_session_hint(chat),
                "summary".into(),
                json!({}),
            )
            .await?;
        if enabled["error"]["code"] == "work_model_disabled" {
            return Ok(enabled);
        }
        let mode = input["mode"]
            .as_str()
            .filter(|m| matches!(*m, "queue" | "steer"))
            .ok_or_else(|| public(400, "instruction_invalid", "Instruction mode is required."))?;
        let key = input["idempotency_key"]
            .as_str()
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| {
                public(
                    400,
                    "instruction_invalid",
                    "Instruction identity is required.",
                )
            })?;
        let client = admission_identity::stable_client_id(
            Some(&Value::from(key)),
            &*self.dependencies.identity_clock,
        )?;
        let request = crate::gateway::MessageSendRequest {
            chat_id: Some(chat.into()),
            text: Some(input["instruction"]["text"].clone()),
            client_message_id: Some(client.clone().into()),
            instruction_mode: Some(mode.into()),
            instruction_expected_epoch: input.get("expected_control_epoch").cloned(),
            attachments: attachment_aliases(&input),
            ..Default::default()
        };
        if let Err(error) = self
            .send(SendMessageCommand {
                chat_id: chat.into(),
                request,
            })
            .await
        {
            if matches!(error,GatewayApplicationError::Public{ref code,..} if code=="queued_message_identity_conflict")
            {
                return Ok(json!({"ok":false,"error":{"code":"idempotency_conflict"}}));
            }
            return Err(error);
        }
        self.dependencies
            .session_work_progress
            .work_model(
                crate::gateway::app_session_hint(chat),
                "instruction_receipt".into(),
                json!({"idempotency_key":client}),
            )
            .await
    }
    pub(super) async fn admit_instruction(
        &self,
        chat: &str,
        client: &str,
    ) -> Result<Option<queue::ClaimOrder>, GatewayApplicationError> {
        let chat_db = chat.to_owned();
        let client_db = client.to_owned();
        let input=self.storage.execute(move |db| {
            let (text, controls, attachments):(String,String,String)=db.query_row("SELECT text,control_resolution_json,attachments_json FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2",params![chat_db,client_db],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(AppStorageError::sqlite)?;
            let controls: Value=serde_json::from_str(&controls).map_err(|_|AppStorageError::new(AppStorageCode::SettingsJsonFailed,"Settings JSON invalid"))?;
            if controls["subsession_result"].is_object() {
                // A child result unblocks its Task's review; it is runtime evidence.
                return Ok(None);
            }
            let attachments: Value=serde_json::from_str(&attachments).map_err(|_|AppStorageError::new(AppStorageCode::SettingsJsonFailed,"Attachment JSON invalid"))?;
            Ok(Some(json!({"expected_control_epoch":controls.get("instruction_expected_epoch"),"transport_turn_id":controls.get("instruction_anchor_turn_id"),"idempotency_key":client_db,"mode":controls.get("instruction_mode").unwrap_or(&json!("queue")),"instruction":{"text":text,"attachment_refs":attachments}})))
        }).await.map_err(app_error)?;
        let Some(input) = input else {
            return Ok(Some(queue::ClaimOrder::Fifo));
        };
        let port = &self.dependencies.session_work_progress;
        let session = crate::gateway::app_session_hint(chat);
        let receipt = port
            .work_model(session.clone(), "app_instruction".into(), input)
            .await?;
        if receipt["error"]["code"] == "work_model_disabled" {
            return Ok(Some(queue::ClaimOrder::Fifo));
        }
        if receipt["ok"] != true {
            return Err(public(
                409,
                "instruction_admission_failed",
                "Instruction admission failed.",
            ));
        }
        self.release_interrupted_boundary(chat, &receipt).await?;
        let gate = port
            .work_model(
                session,
                "instruction_dispatch".into(),
                json!({"idempotency_key":client}),
            )
            .await?;
        Ok(
            (gate["dispatch"] == true).then_some(if gate["bypass"] == true {
                queue::ClaimOrder::Immediate
            } else {
                queue::ClaimOrder::Fifo
            }),
        )
    }
    async fn release_interrupted_boundary(
        &self,
        chat: &str,
        receipt: &Value,
    ) -> Result<(), GatewayApplicationError> {
        use rusqlite::OptionalExtension;
        if receipt["status"] != "waiting_for_turn" {
            return Ok(());
        }
        let Some(turn) = receipt["anchor"]["turn_id"].as_str() else {
            return Ok(());
        };
        let turn_db = turn.to_owned();
        let chat_db = chat.to_owned();
        let interrupted = self.storage.execute(move |db| db.query_row("SELECT 1 FROM turns WHERE id=?1 AND chat_id=?2 AND state='failed' AND safe_error_code='turn_interrupted'",params![turn_db,chat_db], |_| Ok(())).optional().map(|v|v.is_some()).map_err(AppStorageError::sqlite)).await.map_err(app_error)?;
        if interrupted {
            self.dependencies
                .session_work_progress
                .work_model(
                    crate::gateway::app_session_hint(chat),
                    "interrupted_boundary".into(),
                    json!({"turn_id":turn}),
                )
                .await?;
        }
        Ok(())
    }
}

pub(super) fn snapshot_mode(
    db: &rusqlite::Connection,
    request: &crate::gateway::MessageSendRequest,
    persisted: &mut Value,
    chat: &str,
) -> Result<(), AppStorageError> {
    use rusqlite::OptionalExtension;
    persisted["instruction_expected_epoch"] = request
        .instruction_expected_epoch
        .clone()
        .unwrap_or(Value::Null);
    persisted["instruction_mode"] = match &request.instruction_mode {
        Some(mode) => mode.clone(),
        None => settings::follow_up_mode(db)?,
    };
    persisted["instruction_anchor_turn_id"]=db.query_row("SELECT id FROM turns WHERE chat_id=?1 AND state IN ('accepted','thinking','retrying') ORDER BY rowid DESC LIMIT 1",[chat],|r|r.get::<_,String>(0)).optional().map_err(AppStorageError::sqlite)?.map(Value::from).unwrap_or(Value::Null);
    Ok(())
}

fn attachment_aliases(input: &Value) -> Option<Value> {
    input["instruction"].get("attachment_refs").map(|refs| {
        json!(
            refs.as_array()
                .into_iter()
                .flatten()
                .map(|r| if r.is_string() {
                    json!({"file_id":r})
                } else {
                    r.clone()
                })
                .collect::<Vec<_>>()
        )
    })
}
