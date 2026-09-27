//! Operational evidence adapters. Records are persisted per observation;
//! this owner does not retain sessions, prompt bodies, or open file handles.

use std::path::Path;

mod automation;
mod conversation_metrics;
mod cycle_metrics;
mod developer_log;
#[cfg(unix)]
mod mcp_tasks;
mod metric_files;
#[cfg(unix)]
mod observability;
mod prompt_metrics;
#[cfg(unix)]
mod service_readiness;
mod status_summary;
mod update;
mod web_search_metrics;

pub use automation::{
    AutomationCliStore, AutomationCode, AutomationDependencies, AutomationEnqueue, AutomationError,
    AutomationService,
};
pub use conversation_metrics::{AdmissionMeasure, ConversationMetrics};
pub use cycle_metrics::CycleMetrics;
pub use developer_log::{
    DeveloperDiagnosticsSettingsPort, DeveloperLogStore, DeveloperLogWriteAuthority,
    OperationsDeveloperLogCapture,
};
#[cfg(unix)]
pub use mcp_tasks::{
    cleanup_plan, read_mcp_task, read_mcp_task_counts, read_mcp_task_list, read_mcp_task_projects,
};
pub use metric_files::MetricFiles;
#[cfg(unix)]
pub use observability::{LogEntry, LogFile, LogFollower, redact_log_line, tail_log_entries};
pub use prompt_metrics::PromptUsageMetrics;
#[cfg(unix)]
pub use service_readiness::ServiceReadiness;
pub use status_summary::{
    read_context_tool, read_metrics_status, read_prompt_cache_telemetry, read_usage_monitor,
    read_usage_tool, render_metrics_status, render_status_context, tail_operational_metric_events,
};
pub use update::{
    AgentArchiveUpdateService, AgentUpdateRequest, AppUpdateService, UpdateError, UpdateRequest,
};
pub use web_search_metrics::WebSearchMetrics;

#[cfg(unix)]
pub fn metrics_enabled(data_root: &Path) -> bool {
    conversation_metrics::enabled_for_data_root(data_root)
}
