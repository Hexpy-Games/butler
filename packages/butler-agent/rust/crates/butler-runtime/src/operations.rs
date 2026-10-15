//! Operational evidence adapters. Records are persisted per observation;
//! this owner does not retain sessions, prompt bodies, or open file handles.

use std::path::Path;

mod conversation_metrics;
mod cycle_metrics;
mod developer_log;
mod install;
mod log_redaction;
mod log_tail;
mod mcp_tasks;
mod metric_files;
mod observability;
mod prompt_metrics;
mod provider_quota;
mod service_readiness;
mod status_summary;
mod update;
mod usage_cost;
mod web_search_metrics;

pub use conversation_metrics::{AdmissionMeasure, ConversationMetrics};
pub use cycle_metrics::CycleMetrics;
pub use developer_log::{
    DeveloperDiagnosticsSettingsPort, DeveloperLogStore, DeveloperLogWriteAuthority,
    OperationsDeveloperLogCapture,
};
pub use install::{
    Activated, AgentHome, BINARY, HomeLock, HomeRemoval, Installed, InstalledVersion,
    LauncherPaths, LauncherState, LauncherSync, RESOURCES, Switched, sha256_file, sha256_tree,
    version_dir_name,
};
pub use log_tail::LogTail;
pub use mcp_tasks::{
    cleanup_plan, read_mcp_task, read_mcp_task_counts, read_mcp_task_list, read_mcp_task_projects,
};
pub use metric_files::MetricFiles;
pub use observability::{LogEntry, LogFile, LogFollower, redact_log_line, tail_log_entries};
pub use observability::{export_line, log_is_error, log_summary};
pub use prompt_metrics::PromptUsageMetrics;
pub use provider_quota::{
    ProviderQuotaFetcher, ProviderQuotaPoller, ProviderQuotaStore, ProviderQuotaUpdate,
    ProviderQuotaView, QuotaFetchFuture, QuotaPlanKind, QuotaPollStatus, QuotaPollTrigger,
    QuotaUnavailableReason, QuotaWindowView, unavailable_view as unavailable_quota_view,
};
pub use service_readiness::ServiceReadiness;
pub use status_summary::{
    UsageMonitor, UsageMonitorSources, read_context_tool, read_metrics_status,
    read_prompt_cache_telemetry, read_usage_tool, render_metrics_status, render_status_context,
    tail_operational_metric_events,
};
pub use update::{
    AgentArchiveUpdateService, AgentUpdateRequest, AppUpdateService, KEEP_VERSIONS, UpdateError,
    UpdateProgress, UpdateProgressSink, UpdateRequest, effective_update_previews, version_newer,
};
pub use usage_cost::{
    CostReason, SessionUsage, SessionUsageIndex, SessionUsageView, UsageCostView, UsageEvent,
    UsageTotals,
};
pub use web_search_metrics::WebSearchMetrics;

pub fn metrics_enabled(data_root: &Path) -> bool {
    conversation_metrics::enabled_for_data_root(data_root)
}
