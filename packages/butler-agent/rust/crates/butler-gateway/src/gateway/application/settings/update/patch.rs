mod project;
mod sanitize;

use super::super::{composer_decoration, conversation_background, wallpaper};

pub(super) fn project(
    current: &serde_json::Value,
    patch: &serde_json::Value,
    facts: &super::super::AppSettingsFacts,
    workspace_root: &std::path::Path,
) -> serde_json::Value {
    let mut output = project::project(current, patch, facts, workspace_root);
    super::super::proactive::copy(current, &mut output);
    super::super::proactive::copy(patch, &mut output);
    super::super::logging::project(current, patch, &mut output);
    wallpaper::project(current, patch, &mut output);
    composer_decoration::project(current, patch, &mut output);
    conversation_background::project(current, patch, &mut output);
    if let Some(value) = patch.get("consolidation_time") {
        output["consolidation_time"] = value.clone();
    }
    super::super::browsing::project(current, patch, facts, &mut output);
    output
}

pub(super) fn sanitize(
    input: &serde_json::Value,
    facts: &super::super::AppSettingsFacts,
) -> Result<serde_json::Value, crate::gateway::GatewayApplicationError> {
    let mut patch = sanitize::sanitize(input, facts)?;
    super::super::proactive::copy(input, &mut patch);
    if let Some(value) = input.get("consolidation_time") {
        patch["consolidation_time"] = value.clone();
    }
    if let Some(value) = input.get(wallpaper::KEY) {
        let value = wallpaper::sanitize(value)?;
        if let Some(patch) = patch.as_object_mut() {
            patch.insert(wallpaper::KEY.into(), value);
        }
    }
    if let Some(value) = input.get(composer_decoration::KEY) {
        let value = composer_decoration::sanitize(value)?;
        if let Some(patch) = patch.as_object_mut() {
            patch.insert(composer_decoration::KEY.into(), value);
        }
    }
    if let Some(value) = input.get(conversation_background::KEY) {
        let value = conversation_background::sanitize(value)?;
        if let Some(patch) = patch.as_object_mut() {
            patch.insert(conversation_background::KEY.into(), value);
        }
    }
    super::super::browsing::sanitize(input, facts, &mut patch)?;
    Ok(patch)
}
