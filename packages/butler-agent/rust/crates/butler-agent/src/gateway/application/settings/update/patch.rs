mod project;
mod sanitize;

pub(super) fn project(
    current: &serde_json::Value,
    patch: &serde_json::Value,
    facts: &super::super::AppSettingsFacts,
    workspace_root: &std::path::Path,
) -> serde_json::Value {
    project::project(current, patch, facts, workspace_root)
}

pub(super) fn sanitize(
    input: &serde_json::Value,
    facts: &super::super::AppSettingsFacts,
) -> serde_json::Value {
    sanitize::sanitize(input, facts)
}
