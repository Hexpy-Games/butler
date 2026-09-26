use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::resolve_for_message_send;
use crate::gateway::{
    MessageSendRequest,
    application::{AppSettingsFacts, events::EventSubscribers, storage::AppStorageError},
};
use crate::public_text::trim_js_whitespace;

pub(in crate::gateway::application) struct PlanContinuation {
    pub(in crate::gateway::application) queued_id: String,
    pub(in crate::gateway::application) client_message_id: String,
    pub(in crate::gateway::application) chat_id: String,
    pub(in crate::gateway::application) plan_id: String,
    pub(in crate::gateway::application) plan_title: String,
    pub(in crate::gateway::application) facts: Arc<AppSettingsFacts>,
}

pub(in crate::gateway::application) struct PlanInstruction {
    pub(in crate::gateway::application) queued_id: String,
    pub(in crate::gateway::application) client_message_id: String,
    pub(in crate::gateway::application) chat_id: String,
    pub(in crate::gateway::application) plan_id: String,
    pub(in crate::gateway::application) text: String,
    pub(in crate::gateway::application) facts: Arc<AppSettingsFacts>,
}

pub(in crate::gateway::application) fn create_plan_continuation(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: PlanContinuation,
    now: &str,
) -> Result<(), AppStorageError> {
    let text = format!("Proceed with the accepted plan \"{}\".", input.plan_title);
    create_plan_queue_message(
        db,
        subscribers,
        PlanQueueMessage {
            queued_id: input.queued_id,
            client_message_id: stable_client_message_id(&input.client_message_id),
            chat_id: input.chat_id,
            plan_id: input.plan_id,
            text: trim_js_whitespace(&text).to_owned(),
            plan_mode: false,
            replay_conflict: "This Plan continuation was already accepted with different input.",
            facts: input.facts,
        },
        now,
    )
}

pub(in crate::gateway::application) fn create_plan_instruction(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: PlanInstruction,
    now: &str,
) -> Result<(), AppStorageError> {
    create_plan_queue_message(
        db,
        subscribers,
        PlanQueueMessage {
            queued_id: input.queued_id,
            client_message_id: stable_client_message_id(&input.client_message_id),
            chat_id: input.chat_id,
            plan_id: input.plan_id,
            text: trim_js_whitespace(&input.text).to_owned(),
            plan_mode: true,
            replay_conflict: "This client message id was already accepted with different input.",
            facts: input.facts,
        },
        now,
    )
}

struct PlanQueueMessage {
    queued_id: String,
    client_message_id: String,
    chat_id: String,
    plan_id: String,
    text: String,
    plan_mode: bool,
    replay_conflict: &'static str,
    facts: Arc<AppSettingsFacts>,
}

fn create_plan_queue_message(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: PlanQueueMessage,
    now: &str,
) -> Result<(), AppStorageError> {
    let digest = input_digest(&input.text, &input.plan_id, input.plan_mode);
    let existing = db
        .query_row(
            "SELECT input_identity_digest FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2",
            params![input.chat_id,input.client_message_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(existing) = existing {
        if existing.as_deref() != Some(&digest) {
            return Err(AppStorageError::new(
                "queued_message_identity_conflict",
                input.replay_conflict,
            ));
        }
        return Ok(());
    }
    let request = MessageSendRequest {
        subsession_result: None,
        expected_project_id: None,
        content_parts: None,
        chat_id: Some(Value::String(input.chat_id.clone())),
        text: Some(Value::String(input.text.clone())),
        client_message_id: Some(Value::String(input.client_message_id.clone())),
        attachments: None,
        model: None,
        reasoning_effort: None,
        access_mode: None,
        plan_mode: Some(Value::Bool(input.plan_mode)),
    };
    let mut resolved =
        resolve_for_message_send(db, subscribers, &input.chat_id, &request, &input.facts, now)?;
    resolved.persisted["plan_id"] = input.plan_id.clone().into();
    let resolution_json = encoded(&resolved.persisted)?;
    let controls_json = encoded(&resolved.persisted["controls"])?;
    db.execute(
        "INSERT INTO session_queued_messages(\
           id,chat_id,text,client_message_id,input_identity_digest,control_resolution_json,\
           controls_json,attachments_json,content_parts_json,state,safe_error_code,dispatched_message_id,\
           turn_id,claim_id,claim_owner,claimed_at,lease_expires_at,terminal_result_message_id,created_at,updated_at\
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,'[]',NULL,'queued',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?8,?8)",
        params![
            input.queued_id,
            input.chat_id,
            input.text,
            input.client_message_id,
            digest,
            resolution_json,
            controls_json,
            now,
        ],
    )
    .map_err(AppStorageError::sqlite)?;
    let payload = json!({
        "session_id":input.chat_id,
        "queued_message_id":input.queued_id,
        "action":"created",
    });
    super::super::events::append(
        db,
        subscribers,
        "session_queue.changed",
        None,
        payload.as_object().cloned().unwrap_or_default(),
        now,
    )?;
    Ok(())
}

fn input_digest(text: &str, plan_id: &str, plan_mode: bool) -> String {
    let value = json!({
        "version":1,
        "text":text,
        "explicit_controls":{
            "model":null,
            "reasoning_effort":null,
            "access_mode":null,
            "plan_mode":plan_mode,
            "plan_id":plan_id,
            "authority_request_ref":null,
        },
        "admission_identity":[],
    });
    format!(
        "{:x}",
        Sha256::digest(encoded(&value).unwrap_or_default().as_bytes())
    )
}

fn stable_client_message_id(value: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(trim_js_whitespace(value).as_bytes()));
    format!(
        "client-{}-{}-4{}-8{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32],
    )
}

fn encoded(value: &Value) -> Result<String, AppStorageError> {
    crate::json::stringify(value)
        .map_err(|error| AppStorageError::new("settings_json_failed", error.to_string()))
}
