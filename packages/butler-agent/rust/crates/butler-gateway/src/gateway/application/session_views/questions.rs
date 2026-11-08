use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use crate::gateway::{MessageRecord, MessageRole};
use serde_json::{Value, json};

pub(super) async fn read(
    app: &AppApplication,
    owner: &str,
    messages: &[MessageRecord],
    active: Option<&str>,
) -> Result<(Value, Value, Value), GatewayApplicationError> {
    let _measurement = app.storage.measure_view("questions");
    let mut turns: Vec<String> = messages.iter().filter_map(|m| m.turn_id.clone()).collect();
    turns.extend(active.map(str::to_owned));
    turns.extend(followup_refs(app, messages).await?);
    turns.sort();
    turns.dedup();
    let (requests, mut answers) = app
        .dependencies
        .authority_handoff
        .session_requests(owner.into(), turns)
        .await?;
    // The follow-up's public id is the canonical form of its queued client id.
    for answer in &mut answers {
        if let Some(reference) = answer["request_ref"].as_str() {
            let client = format!(
                "{}{reference}",
                super::super::question_followup::CLIENT_ID_PREFIX
            );
            answer["followup_message_id"] =
                super::super::admission_identity::canonical_client_id(&client).into();
        }
    }
    let (pending, approvals): (Vec<_>, Vec<_>) = requests
        .into_iter()
        .partition(|request| request["category"] == "ask_user");
    Ok((json!(pending), json!(answers), json!(approvals)))
}

/// A later answer's admission records its request, so a page holding only the follow-up still finds it.
async fn followup_refs(
    app: &AppApplication,
    messages: &[MessageRecord],
) -> Result<Vec<String>, GatewayApplicationError> {
    let Some(chat) = messages.first().map(|m| m.chat_id.clone()) else {
        return Ok(Vec::new());
    };
    let ids: Vec<&str> = messages
        .iter()
        .filter(|m| matches!(m.role, MessageRole::User))
        .map(|m| m.id.as_str())
        .collect();
    let ids = serde_json::to_string(&ids).map_err(GatewayApplicationError::internal_from)?;
    app.storage
        .read(move |db| {
            let mut statement = db
                .prepare_cached(
                    "SELECT json_extract(control_resolution_json,'$.question_ref') FROM session_queued_messages \
                     WHERE chat_id=?1 AND client_message_id IN (SELECT value FROM json_each(?2)) \
                     AND json_extract(control_resolution_json,'$.question_ref') IS NOT NULL",
                )
                .map_err(AppStorageError::sqlite)?;
            let refs = statement
                .query_map(rusqlite::params![chat, ids], |row| row.get::<_, String>(0))
                .map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(AppStorageError::sqlite)?;
            Ok(refs)
        })
        .await
        .map_err(app_error)
}
