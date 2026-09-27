//! Source-compatible model tool projections through the Models owner.

use std::path::Path;

use rmcp::model::{CallToolResult, ContentBlock};

use super::super::ResolvedInstallation;
use crate::models::{self, McpModelTarget};

pub(super) fn list() -> CallToolResult {
    let lines = [
        "Available models:",
        "",
        "Aliases:",
        "  gpt-6-astra",
        "  gpt-5.6-sol",
        "  gpt-5.6-terra",
        "  gpt-5.6-luna",
        "  gpt-5.5-codex",
        "  gpt-5.5",
        "  gpt-5.4",
        "  gpt-5.4-mini",
        "  auto:codex-latest",
        "",
        "Legacy (full IDs):",
    ]
    .join("\n");
    success(lines)
}

pub(super) async fn details_or_set(
    installation: &ResolvedInstallation,
    data_root: &Path,
    target: Option<&str>,
    model: Option<&str>,
) -> CallToolResult {
    let config = match models::open_status_models(data_root.to_path_buf()).await {
        Ok(value) => value.configuration,
        Err(error) => return tool_error(error.to_string()),
    };
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        let target = target_value(target);
        let config_path = data_root.join("butler.config.json");
        if !valid_config_write_path(installation, data_root, &config_path) {
            return success("native_path_configuration_invalid".into());
        }
        let result = config.set_mcp_model(target, model).await;
        return match result {
            Ok(()) if target == McpModelTarget::Butler => success(format!(
                "Butler model changed to: {model} (applies at next restart)"
            )),
            Ok(()) => success(format!("Worker model changed to: {model}")),
            Err(error) => success(error.to_string()),
        };
    }

    let text = match target {
        None => {
            let worker = config.mcp_model_details(McpModelTarget::Worker);
            let butler = config.mcp_model_details(McpModelTarget::Butler);
            format!(
                "Worker model: {}\n  provider: {}\n  model: {}\n  canonical: {}\nButler model: {}\n  provider: {}\n  model: {}\n  canonical: {}",
                worker.raw,
                worker.provider_id,
                worker.model_id,
                worker.canonical_ref,
                butler.raw,
                butler.provider_id,
                butler.model_id,
                butler.canonical_ref,
            )
        }
        Some("butler") => details_text(&config, McpModelTarget::Butler, false),
        _ => details_text(&config, McpModelTarget::Worker, false),
    };
    success(text)
}

fn details_text(
    config: &models::ModelConfiguration,
    target: McpModelTarget,
    indent: bool,
) -> String {
    let details = config.mcp_model_details(target);
    let name = if target == McpModelTarget::Butler {
        "Butler"
    } else {
        "Worker"
    };
    let prefix = if indent { "  " } else { "" };
    format!(
        "{name} model: {}\n{prefix}provider: {}\n{prefix}model: {}\n{prefix}canonical: {}",
        details.raw, details.provider_id, details.model_id, details.canonical_ref,
    )
}

fn target_value(target: Option<&str>) -> McpModelTarget {
    if target == Some("butler") {
        McpModelTarget::Butler
    } else {
        McpModelTarget::Worker
    }
}

fn valid_config_write_path(
    installation: &ResolvedInstallation,
    data_root: &Path,
    config_path: &Path,
) -> bool {
    let Ok(data) = installation.validate_data_root(data_root) else {
        return false;
    };
    installation
        .validate_data_root(config_path)
        .is_ok_and(|config| config.starts_with(data))
}

fn success(text: String) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(text)])
}

fn tool_error(text: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}
