//! Child progress and activity windows from durable publication facts.
use butler_gateway::gateway::GatewayApplicationError;
use butler_turn::btcc::StorageProgressPublication;

pub(super) async fn with_history(
    progress: &StorageProgressPublication,
    session: &str,
    first: Option<String>,
    starts_at_beginning: bool,
    projection: &mut serde_json::Value,
) -> Result<(), GatewayApplicationError> {
    let Some(latest) = projection
        .pointer("/latest_turn/id")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    // An empty forward window still reads the latest turn, without older history.
    let first = if starts_at_beginning {
        None
    } else {
        first.or_else(|| Some(latest.to_owned()))
    };
    let window = progress
        .read_child_activity_window(session.to_owned(), first, latest.to_owned())
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    projection["activity_history"] = window["activity_history"].clone();
    projection["public_progress_events"] = window["public_progress_events"].clone();
    Ok(())
}

pub(super) async fn with_progress(
    progress: &StorageProgressPublication,
    projection: &mut serde_json::Value,
) -> Result<(), GatewayApplicationError> {
    for key in ["steward_children"] {
        if let Some(children) = projection
            .get_mut(key)
            .and_then(serde_json::Value::as_array_mut)
        {
            for child in children {
                child_progress(progress, child).await?;
            }
        }
    }
    if projection
        .get("relation")
        .is_some_and(serde_json::Value::is_object)
    {
        child_progress(progress, projection).await?;
    }
    Ok(())
}

async fn child_progress(
    progress: &StorageProgressPublication,
    child: &mut serde_json::Value,
) -> Result<(), GatewayApplicationError> {
    if child.get("public_progress_events").is_some() {
        return Ok(());
    }
    let Some(id) = child
        .pointer("/latest_turn/id")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(());
    };
    let events = progress
        .read_child_progress_events(id.to_owned())
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    child["public_progress_events"] = serde_json::json!(events);
    Ok(())
}
