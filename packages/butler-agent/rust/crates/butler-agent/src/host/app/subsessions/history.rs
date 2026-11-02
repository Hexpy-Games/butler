//! The own child view carries a bounded page independent of its message window.
use super::*;
use serde_json::{Value, json};

pub(super) async fn enrich(
    progress: &StorageProgressPublication,
    session: &str,
    page: Option<&AppSessionViewPage>,
    projection: &mut Value,
) -> Result<(), GatewayApplicationError> {
    if !projection["relation"].is_object() {
        return Ok(());
    }
    let after = page
        .and_then(|page| page.activity_after_cursor)
        .unwrap_or(0);
    let limit = page.map_or(200, |page| page.limit);
    let (events, cursor, has_more) = progress
        .read_child_activity_page(session.into(), after, limit)
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    let latest = projection
        .pointer("/latest_turn/id")
        .and_then(Value::as_str);
    projection["public_progress_events"] = json!(
        events
            .iter()
            .filter(|event| event["turnId"].as_str() == latest)
            .collect::<Vec<_>>()
    );
    projection["public_activity_events"] = json!(events);
    projection["activity_window"] = json!({"next_cursor":cursor,"has_more":has_more});
    Ok(())
}
