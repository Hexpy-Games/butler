//! Explicit coverage of the first executable native slice, not full tool parity.

use butler_turn::btcc::{BtccError, GuidedCatalogSnapshot, GuidedPhaseSelection, ModelRoundTool};

pub(super) fn with_worker_profile_choices(
    phase: &mut GuidedPhaseSelection,
    profiles: &[butler_turn::btcc::WorkerProfile],
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
                .map_err(|source| super::error("worker_profile_settings_invalid").with_source(source))?
        )
        .into();
        definition["parameters"]["properties"]["profile_id"] =
            serde_json::json!({"type":"string","enum":ids});
    }
    Ok(())
}

/// Offer the same capability choices that image input validation enforces.
pub(super) fn with_image_model_choices(
    phase: &mut GuidedPhaseSelection,
    settings: Option<&serde_json::Value>,
) {
    let selected = settings
        .and_then(|s| s.get("selected"))
        .filter(|s| !s.is_null());
    let capability = settings
        .and_then(|s| s["models"].as_array())
        .and_then(|models| {
            models
                .iter()
                .find(|m| Some(&m["model_ref"]) == selected.map(|s| &s["model_ref"]))
        });
    let Some(capability) = capability else {
        for name in ["generate_image", "edit_image"] {
            phase.authorized_names.retain(|n| n != name);
            phase.provider_tools.retain(|t| t["name"] != name);
        }
        return;
    };
    for tool in &mut phase.provider_tools {
        if tool["name"] != "generate_image" && tool["name"] != "edit_image" {
            continue;
        }
        for (key, choices) in [("size", "sizes"), ("quality", "qualities")] {
            if key == "quality" && capability[choices].as_array().is_some_and(Vec::is_empty) {
                if let Some(properties) = tool["parameters"]["properties"].as_object_mut() {
                    properties.remove(key);
                }
                if let Some(required) = tool["parameters"]["required"].as_array_mut() {
                    required.retain(|v| v != key);
                }
                continue;
            }
            let property = &mut tool["parameters"]["properties"][key];
            property["enum"] = capability[choices].clone();
        }
    }
}

pub(super) fn available(
    phase: &mut GuidedPhaseSelection,
    catalog: &GuidedCatalogSnapshot,
) -> Result<Vec<ModelRoundTool>, BtccError> {
    let implemented = crate::host::GuidedTools::supports;
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
            serde_json::from_value(definition.clone()).map_err(|source| {
                super::error("guided_provider_tool_definition_invalid").with_source(source)
            })
        })
        .collect()
}

pub(in crate::host::guided) async fn for_owner(
    phase: &mut GuidedPhaseSelection,
    subsessions: &butler_turn::btcc::SubsessionService,
    monitoring: &crate::host::MonitoringReaders,
    catalog: &GuidedCatalogSnapshot,
) -> Result<Vec<ModelRoundTool>, BtccError> {
    if phase.execution_policy.role == butler_turn::btcc::PolicyRole::Steward
        && phase.provider_tools.iter().any(|tool| {
            tool.get("name").and_then(serde_json::Value::as_str) == Some("delegate_to_worker")
        })
    {
        let profiles = subsessions.enabled_worker_profiles().await?;
        with_worker_profile_choices(phase, &profiles)?;
    }
    // Only the Steward partitions work into Tasks. Other roles retain their
    // compact planning schema; the catalog still documents the full contract.
    if phase.execution_policy.role != butler_turn::btcc::PolicyRole::Steward {
        for definition in &mut phase.provider_tools {
            if definition.get("name").and_then(serde_json::Value::as_str)
                == Some("replace_work_plan")
                && let Some(properties) = definition
                    .pointer_mut("/parameters/properties")
                    .and_then(serde_json::Value::as_object_mut)
            {
                properties.remove("subjects");
            }
        }
    }
    let image_settings = monitoring.configuration.image_model_settings().await.ok();
    with_image_model_choices(phase, image_settings.as_ref());
    available(phase, catalog)
}
