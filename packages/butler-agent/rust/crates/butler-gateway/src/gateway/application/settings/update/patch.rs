mod project;
mod sanitize;

use super::super::{composer_decoration, wallpaper};

pub(super) fn project(
    current: &serde_json::Value,
    patch: &serde_json::Value,
    facts: &super::super::AppSettingsFacts,
    workspace_root: &std::path::Path,
) -> serde_json::Value {
    let mut output = project::project(current, patch, facts, workspace_root);
    wallpaper::project(current, patch, &mut output);
    composer_decoration::project(current, patch, &mut output);
    output
}

pub(super) fn sanitize(
    input: &serde_json::Value,
    facts: &super::super::AppSettingsFacts,
) -> Result<serde_json::Value, crate::gateway::GatewayApplicationError> {
    let mut patch = sanitize::sanitize(input, facts)?;
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
    Ok(patch)
}
