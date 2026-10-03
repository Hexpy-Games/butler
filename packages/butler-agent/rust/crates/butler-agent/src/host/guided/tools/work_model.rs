//! Refresh the narrow grouped surface after same-Turn bootstrap.
use super::*;

pub(super) fn authorized(owner: &GuidedTools, name: &str) -> bool {
    (owner.binding.visible_names.contains(name) && owner.binding.authorized_names.contains(name))
        || (name == "session_control" && owner.state.lock().managed_control)
}

pub(super) async fn surface(owner: &GuidedTools) -> Result<Vec<ModelRoundTool>, BtccError> {
    let mut tools = owner.binding.surface.clone();
    let Some(model) = owner.work.work_model() else {
        return Ok(tools);
    };
    if !owner.binding.authorized_names.contains("work_apply") {
        return Ok(tools);
    }
    let summary = model
        .summary(owner.binding.source_session_id.clone(), None)
        .await?;
    if summary["tier"] == 0 {
        return Ok(tools);
    }
    let authority = model
        .instruction_authority(owner.binding.source_session_id.clone())
        .await?;
    let child = !authority["parent_session_id"].is_null();
    tools.retain(|t| {
        !matches!(
            t.name.as_str(),
            "work_apply"
                | "work_read"
                | "session_control"
                | "steer_steward"
                | "steer_worker"
                | "cancel_steward"
        )
    });
    let mut definitions = super::super::work_model::schema::definitions(
        summary["status"] == "completed" && !child,
        child,
    );
    if summary["tier"] == 2 {
        definitions.push(super::super::work_model::schema::control());
    }
    for definition in definitions {
        tools.push(serde_json::from_value(definition).map_err(|e| {
            BtccError::relayed("work_model_schema_invalid", "Invalid grouped tool schema")
                .with_source(e)
        })?);
    }
    owner.state.lock().managed_control = summary["tier"] == 2;
    Ok(tools)
}
