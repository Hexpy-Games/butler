use super::super::{AppApplication, GatewayApplicationError};
use crate::gateway::MessageRecord;
use serde_json::{Value, json};

pub(super) async fn read(
    app: &AppApplication,
    owner: &str,
    messages: &[MessageRecord],
    active: Option<&str>,
) -> Result<(Value, Value, Value), GatewayApplicationError> {
    let mut turns: Vec<String> = messages.iter().filter_map(|m| m.turn_id.clone()).collect();
    turns.extend(active.map(str::to_owned));
    turns.extend(
        messages
            .iter()
            .filter_map(|m| m.id.strip_prefix("question-followup-").map(str::to_owned)),
    );
    turns.sort();
    turns.dedup();
    let (requests, answers) = app
        .dependencies
        .authority_handoff
        .session_requests(owner.into(), turns)
        .await?;
    let (pending, approvals): (Vec<_>, Vec<_>) = requests
        .into_iter()
        .partition(|request| request["category"] == "ask_user");
    Ok((json!(pending), json!(answers), json!(approvals)))
}

pub(super) async fn insert(
    app: &AppApplication,
    view: &mut serde_json::Map<String, Value>,
    owner: &str,
    messages: &[MessageRecord],
    active: Option<&str>,
) -> Result<(), GatewayApplicationError> {
    let (pending, answers, approvals) = read(app, owner, messages, active).await?;
    view.insert("pending_questions".into(), pending);
    view.insert("authority_requests".into(), approvals);
    view.insert("question_answers".into(), answers);
    Ok(())
}
