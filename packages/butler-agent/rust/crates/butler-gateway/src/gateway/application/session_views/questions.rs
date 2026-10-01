use super::super::{AppApplication, GatewayApplicationError};
use crate::gateway::MessageRecord;
use serde_json::{Value, json};

pub(super) async fn read(
    app: &AppApplication,
    owner: &str,
    messages: &[MessageRecord],
    active: Option<&str>,
) -> Result<(Value, Value, Value), GatewayApplicationError> {
    let page = app
        .dependencies
        .authority_handoff
        .list(owner.into())
        .await?;
    let approvals: Vec<_> = page
        .requests
        .iter()
        .filter(|r| r["category"] != "ask_user")
        .cloned()
        .collect();
    let pending: Vec<_> = page
        .requests
        .into_iter()
        .filter(|r| r["category"] == "ask_user")
        .collect();
    let mut turns: Vec<String> = messages.iter().filter_map(|m| m.turn_id.clone()).collect();
    turns.extend(active.map(str::to_owned));
    turns.extend(
        messages
            .iter()
            .filter_map(|m| m.id.strip_prefix("question-followup-").map(str::to_owned)),
    );
    turns.sort();
    turns.dedup();
    let answers = app
        .dependencies
        .authority_handoff
        .question_history(owner.into(), turns)
        .await?;
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
