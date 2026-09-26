//! Per-Turn monitoring adapters; domain readers own facts and the outer ToolPort journals.

use std::{path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use crate::{
    btcc::{BtccError, ModelRoundToolCall, ToolExecutionError},
    json::JsonDocument,
};

use super::NativeGuidedTools;

pub(crate) struct MonitoringReaders {
    data_root: PathBuf,
    configuration: Arc<crate::models::ModelConfiguration>,
    catalog: Arc<crate::models::ModelCatalog>,
    memory_health: Arc<crate::cognition::MemoryHealthService>,
    profile: Arc<crate::profile::ProfileService>,
    metrics: Arc<crate::operations::CycleMetrics>,
}

impl MonitoringReaders {
    pub(in crate::host) fn new(
        data_root: PathBuf,
        configuration: Arc<crate::models::ModelConfiguration>,
        catalog: Arc<crate::models::ModelCatalog>,
        memory_health: Arc<crate::cognition::MemoryHealthService>,
        profile: Arc<crate::profile::ProfileService>,
        metrics: Arc<crate::operations::CycleMetrics>,
    ) -> Self {
        Self {
            data_root,
            configuration,
            catalog,
            memory_health,
            profile,
            metrics,
        }
    }

    async fn context(&self, session: &str, model_ref: &str) -> Value {
        crate::operations::read_context_tool(
            &self.data_root,
            session,
            model_ref,
            self.configuration.clone(),
            self.catalog.clone(),
        )
        .await
    }

    fn usage(&self, session: &str, since_ts: Option<f64>) -> Value {
        crate::operations::read_usage_tool(&self.data_root, session, since_ts)
    }

    async fn memory_health(&self) -> Result<Value, BtccError> {
        let profile = self
            .profile
            .read_coverage_health()
            .await
            .map_err(|error| BtccError::new(error.code, error.message))?;
        let report = self
            .memory_health
            .read_tool(profile)
            .await
            .map_err(|error| BtccError::new(error.code, error.message))?;
        self.metrics.record(
            "health",
            report.metric_status,
            report.metric_dimensions.clone(),
        );
        Ok(report.summary)
    }
}

const CATEGORIES: [&str; 14] = [
    "search",
    "data",
    "command",
    "file",
    "work",
    "monitoring",
    "automation",
    "todo",
    "memory",
    "project",
    "skill",
    "mcp",
    "dispatch",
    "control",
];

pub(super) fn supports(name: &str) -> bool {
    matches!(
        name,
        "get_context_monitor"
            | "get_usage_monitor"
            | "get_memory_health"
            | "list_tool_capabilities"
    )
}

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let session = call
        .arguments
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&owner.binding.source_session_id);
    let result = match call.name.as_str() {
        "list_tool_capabilities" => list_capabilities(owner, call),
        "get_context_monitor" => {
            let mut value = owner
                .monitoring
                .context(session, &owner.binding.model_ref)
                .await;
            value["ok"] = json!(true);
            value
        }
        "get_usage_monitor" => {
            let since = call
                .arguments
                .get("since_hours")
                .and_then(Value::as_f64)
                .filter(|hours| *hours > 0.0)
                .map(|hours| chrono::Utc::now().timestamp_millis() as f64 - hours * 3_600_000.0);
            let mut value = owner.monitoring.usage(session, since);
            value["ok"] = json!(true);
            value
        }
        "get_memory_health" => {
            let mut value = owner
                .monitoring
                .memory_health()
                .await
                .map_err(ToolExecutionError::Integrity)?;
            value["ok"] = json!(true);
            value
        }
        _ => unreachable!("monitoring dispatch checks supports"),
    };
    JsonDocument::from_value(&result).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "monitoring_result_invalid",
            error.to_string(),
        ))
    })
}

fn list_capabilities(owner: &NativeGuidedTools, call: &ModelRoundToolCall) -> Value {
    let raw = call.arguments.get("category");
    let category = raw.and_then(|value| match value {
        Value::String(value) => Some(value.trim().to_ascii_lowercase()),
        Value::Null => None,
        _ => Some(value.to_string()),
    });
    let category = match category.as_deref() {
        None | Some("" | "all" | "any" | "native" | "registry" | "workspace") => None,
        Some("shell" | "terminal" | "execution" | "execute") => Some("command"),
        Some("filesystem" | "files") => Some("file"),
        Some(category) if CATEGORIES.contains(&category) => Some(category),
        Some(_) => {
            let invalid = raw
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .unwrap_or_else(|| raw.unwrap_or(&Value::Null).to_string());
            return json!({"ok":false,"error":{"code":"invalid_tool_category",
                "message":format!("Unknown tool capability category: {invalid}")},
                "invalid_category":invalid,"valid_categories":CATEGORIES,"capabilities":[]});
        }
    };
    let include_disabled = call.arguments.get("include_disabled") != Some(&Value::Bool(false));
    let mut items = owner
        .catalog
        .snapshot()
        .capability_tools()
        .filter_map(|tool| {
            let item_category = tool.category.unwrap_or("control");
            if category.is_some_and(|selected| selected != item_category) {
                return None;
            }
            let disabled = owner.web_session.configured_disabled_reason(tool.name);
            let implemented = NativeGuidedTools::supports(tool.name);
            let enabled = implemented && disabled.is_none();
            if !include_disabled && !enabled {
                return None;
            }
            let selected = owner.binding.visible_names.contains(tool.name);
            let callable =
                selected && enabled && owner.binding.authorized_names.contains(tool.name);
            let reason = disabled
                .map(|value| value.0)
                .or_else(|| (!implemented).then_some("native_executor_unavailable"));
            Some(json!({
                "name":tool.name,
                "description":tool.definition["description"],
                "category":item_category,
                "enabled":enabled,
                "disabled_reason":reason,
                "current_turn_selected":selected,
                "current_turn_callable":callable,
                "omitted_by_profile":!selected,
                "availability_scope":if callable { "current_turn" } else { "registry" },
                "concurrency_safe":tool.definition["concurrencySafe"],
                "interrupt_behavior":tool.definition["interruptBehavior"],
                "transcript_visibility":tool.definition["transcriptVisibility"],
                "tags":tool.tags,
                "safety_notes":if tool.safety_notes.is_empty() {
                    json!(["Use only when the tool schema matches the user's intent."])
                } else { json!(tool.safety_notes) },
            }))
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        left["category"]
            .as_str()
            .cmp(&right["category"].as_str())
            .then_with(|| left["name"].as_str().cmp(&right["name"].as_str()))
    });
    json!({"ok":true,"current_turn_surface_known":true,
        "valid_categories":CATEGORIES,"capabilities":items})
}
