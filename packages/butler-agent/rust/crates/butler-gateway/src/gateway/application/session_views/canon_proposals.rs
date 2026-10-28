//! Transcript pages discover cards by their indexed turn/call anchors.
use super::*;
pub(super) async fn insert(
    app: &AppApplication,
    messages: &[crate::gateway::MessageRecord],
    view: &mut Map<String, Value>,
) -> Result<(), GatewayApplicationError> {
    let mut turns = messages
        .iter()
        .filter_map(|m| m.turn_id.clone())
        .collect::<Vec<_>>();
    turns.sort();
    turns.dedup();
    let cards = app
        .dependencies
        .canon
        .proposal("turns".into(), json!({"turns":turns}))
        .await?;
    view.insert("canon_proposals".into(), cards);
    Ok(())
}
