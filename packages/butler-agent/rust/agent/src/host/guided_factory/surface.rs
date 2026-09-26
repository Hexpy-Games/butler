//! Explicit coverage of the first executable native slice, not full tool parity.

use crate::btcc::{BtccError, GuidedCatalogSnapshot, GuidedPhaseSelection, ModelRoundTool};

pub(super) fn with_worker_profile_choices(
    phase: &mut GuidedPhaseSelection,
    profiles: &[crate::btcc::WorkerProfile],
) -> Result<(), BtccError> {
    if profiles.is_empty() {
        return Ok(());
    }
    let choices = profiles
        .iter()
        .map(|profile| {
            let job = match profile.job.get("kind").and_then(serde_json::Value::as_str) {
                Some("builtin") => profile.job.get("job"),
                Some("custom") => profile.job.get("text"),
                _ => None,
            }
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| super::error("worker_profile_settings_invalid"))?;
            Ok(serde_json::json!({"id":profile.id,"label":profile.label,"job":job}))
        })
        .collect::<Result<Vec<_>, BtccError>>()?;
    let ids = choices
        .iter()
        .filter_map(|choice| choice.get("id").cloned())
        .collect::<Vec<_>>();
    for definition in &mut phase.provider_tools {
        if definition.get("name").and_then(serde_json::Value::as_str) != Some("delegate_to_worker")
        {
            continue;
        }
        let description = definition
            .get("description")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| super::error("guided_provider_tool_definition_invalid"))?;
        definition["description"] = format!(
            "{description} Available profiles: {}. Profile ids are opaque selectors; choose by label and job, or omit profile_id to use default.",
            serde_json::to_string(&choices)
                .map_err(|_| super::error("worker_profile_settings_invalid"))?
        )
        .into();
        definition["parameters"]["properties"]["profile_id"] =
            serde_json::json!({"type":"string","enum":ids});
    }
    Ok(())
}

pub(super) fn available(
    phase: &mut GuidedPhaseSelection,
    catalog: &GuidedCatalogSnapshot,
) -> Result<Vec<ModelRoundTool>, BtccError> {
    let implemented = crate::host::NativeGuidedTools::supports;
    if phase
        .execution_policy
        .required_tools
        .iter()
        .any(|name| !implemented(name))
        || phase
            .execution_policy
            .required_profiles
            .iter()
            .any(|profile| {
                catalog
                    .profile_tool_names(profile)
                    .is_none_or(|names| names.iter().any(|name| !implemented(name)))
            })
    {
        return Err(super::error("guided_required_native_tool_unavailable"));
    }
    phase.authorized_names.retain(|name| implemented(name));
    phase.provider_tools.retain(|definition| {
        definition
            .get("name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(implemented)
    });
    phase
        .provider_tools
        .iter()
        .map(|definition| {
            serde_json::from_value(definition.clone())
                .map_err(|_| super::error("guided_provider_tool_definition_invalid"))
        })
        .collect()
}
