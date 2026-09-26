//! Native host adapters shared by the composed domain owners.
//!
//! The system clock and UUID generator retain no Turn/session state. Domain
//! ports remain explicit; domains do not depend on this composition module.

#[cfg(unix)]
mod app_monitoring;
#[cfg(unix)]
mod app_runtime_ports;
mod authority_handoff;
#[cfg(unix)]
mod automation_cli;
#[cfg(unix)]
mod briefing_generation;
#[cfg(unix)]
mod cognition_operator_cli;
mod cognition_prompt;
#[cfg(unix)]
mod consolidation_cli;
#[cfg(unix)]
mod consolidation_phase;
#[cfg(unix)]
mod context_cli;
mod conversation_observer;
#[cfg(unix)]
mod conversation_recovery_cli;
#[cfg(unix)]
mod coordination;
#[cfg(unix)]
mod daily_cognition;
mod daily_schedule;
mod developer_log;
#[cfg(unix)]
mod doctor_cli;
mod effect_registered_edit;
mod effect_registered_write;
#[cfg(unix)]
mod embedding_owner;
#[cfg(unix)]
mod embedding_worker;
#[cfg(unix)]
mod foreground_lease;
#[cfg(unix)]
mod gateway_cli;
#[cfg(unix)]
mod gateway_lifecycle;
mod guided_activity;
mod guided_catalog;
mod guided_command;
mod guided_factory;
mod guided_file_effects;
mod guided_journal;
mod guided_preparation;
mod guided_project_tools;
mod guided_prompt;
mod guided_steering;
mod guided_tools;
mod guided_work;
mod guided_work_tools;
mod installation;
#[cfg(unix)]
mod legacy_session_sync;
#[cfg(unix)]
mod mcp;
#[cfg(unix)]
mod memory_initialize;
#[cfg(unix)]
mod memory_maintain;
#[cfg(unix)]
mod memory_maintain_phase;
#[cfg(unix)]
mod memory_rebuild;
mod memory_source;
mod memory_sync;
pub(crate) use memory_source::NativeMemorySourceReader;
#[cfg(unix)]
mod native_app;
mod native_app_dashboard;
mod native_app_dashboard_briefing;
mod native_app_plan_decision;
mod native_app_subsessions;
mod native_ingress;
mod native_tool_artifact;
#[cfg(unix)]
mod oauth_login;
#[cfg(unix)]
mod observability_cli;
#[cfg(unix)]
mod personalization_cli;
pub(crate) use native_tool_artifact::NativeToolArtifactReader;
#[cfg(unix)]
mod native_service;
mod process_environment;
mod process_models;
#[cfg(unix)]
mod profile_consolidation;
mod profile_sources;
mod progress_publisher;
mod project_plan;
mod project_work_provider;
mod prompt_clock;
#[cfg(unix)]
mod public_cli;
mod recall_metrics;
#[cfg(unix)]
mod restart_handoff;
mod runtime;
mod runtime_stores;
mod scope_selected_work;
#[cfg(unix)]
mod service_cli;
mod service_configuration;
mod service_delivery;
#[cfg(unix)]
mod service_instance;
#[cfg(unix)]
mod service_instance_identity;
#[cfg(unix)]
mod settings_cli;
mod skills_cli;
#[cfg(unix)]
mod status_cli;
mod storage_bootstrap;
#[cfg(unix)]
mod transport_cli;
#[cfg(unix)]
mod web_access_cli;
#[cfg(unix)]
mod work_cli;
mod work_streams;
#[cfg(unix)]
mod worker_profiles;
mod zai_vision;

#[cfg(unix)]
pub(crate) use app_monitoring::NativeAppMonitoring;
#[cfg(unix)]
pub(crate) use app_runtime_ports::{
    NativeAppAdmission, NativeAppApprovalClaims, NativeAppAssets, NativeAppBranchConversations,
    NativeAppBranchSummarizer, NativeAppContextRead, NativeAppIngress, NativeAppModelCatalog,
    NativeAppPersonalization, NativeAppQueueOwnerLiveness, NativeAppReadiness,
    NativeAppSessionProgress, NativeAppSessionWorkspaces, NativeAppSettingsFacts,
    NativeAppSettingsMutation,
};
pub(crate) use authority_handoff::NativeAuthorityHandoff;
pub(crate) use cognition_prompt::NativeCognitionPrompt;
pub(crate) use conversation_observer::NativeConversationObserver;
pub(crate) use effect_registered_edit::NativeRegisteredEdit;
pub(crate) use effect_registered_write::{NativeRegisteredWrite, RegisteredWriteContext};
pub(crate) use guided_activity::NativeGuidedActivity;
pub(crate) use guided_catalog::NativeGuidedCatalog;
pub(crate) use guided_factory::NativeGuidedTurnFactory;
pub(crate) use guided_file_effects::NativeGuidedFileEffects;
pub(crate) use guided_journal::NativeGuidedJournal;
pub(crate) use guided_preparation::{NativeGuidedPreparation, PreparedNativeGuidedTurn};
pub(crate) use guided_prompt::{
    GuidedTextState, NativeGuidedPrompt, resolve_guided_response_language,
};
pub(crate) use guided_steering::NativeGuidedSteering;
use guided_tools::MonitoringReaders;
pub(crate) use guided_tools::{GuidedToolBinding, NativeGuidedTools};
pub(crate) use guided_work::NativeGuidedWork;
pub(crate) use guided_work_tools::NativeGuidedWorkTools;
#[cfg(unix)]
pub(crate) use native_app::NativeAppServer;
pub(crate) use native_app_subsessions::NativeAppSubsessions;
mod automation_queue;
mod automation_runtime;
mod context_maintenance;
mod date_parser;
mod timezone_data;
mod tool_output;
#[cfg(unix)]
mod update_cli;
pub(crate) use automation_queue::NativeAutomationQueue;
pub(crate) use automation_runtime::open_automation_service;
pub(crate) use date_parser::NativeDateParser;

#[cfg(unix)]
pub(crate) use embedding_owner::NativeEmbeddingOwner;
#[cfg(unix)]
pub use embedding_worker::run as run_private_embedding_worker;
#[cfg(unix)]
pub(crate) use gateway_lifecycle::NativeActiveAppEndpoint;
pub(crate) use tool_output::native_tool_output;

#[cfg(unix)]
pub use automation_cli::{
    recognizes as native_automation_cli_recognizes, run as run_native_automation_cli,
};
#[cfg(unix)]
pub use cognition_operator_cli::{
    recognizes as native_cognition_operator_cli_recognizes,
    run as run_native_cognition_operator_cli,
};
#[cfg(unix)]
pub use consolidation_cli::{NativeConsolidationCliResult, run_native_consolidation_cli};
#[cfg(unix)]
pub use context_cli::{recognizes as native_context_cli_recognizes, run as run_native_context_cli};
#[cfg(unix)]
pub use conversation_recovery_cli::{
    recognizes as native_conversation_recovery_cli_recognizes,
    run as run_native_conversation_recovery_cli,
};
#[cfg(unix)]
pub use doctor_cli::{recognizes as native_doctor_cli_recognizes, run as run_native_doctor_cli};
#[cfg(unix)]
pub use gateway_cli::{recognizes as native_gateway_cli_recognizes, run as run_native_gateway_cli};
#[cfg(unix)]
pub use installation::ResolvedInstallation;
#[cfg(unix)]
pub use mcp::{recognizes as native_mcp_cli_recognizes, run as run_native_mcp_cli};
#[cfg(unix)]
pub use memory_initialize::run as run_native_memory_initialize_cli;
#[cfg(unix)]
pub use memory_maintain::run as run_native_memory_maintain_cli;
#[cfg(unix)]
pub use memory_rebuild::run as run_native_memory_rebuild_cli;
#[cfg(unix)]
pub use native_service::run_native_service;
#[cfg(unix)]
pub use oauth_login::run_native_oauth_login;
#[cfg(unix)]
pub use observability_cli::{
    recognizes as native_observability_cli_recognizes, run as run_native_observability_cli,
};
#[cfg(unix)]
pub use personalization_cli::{
    recognizes as native_personalization_cli_recognizes, run as run_native_personalization_cli,
};
pub(crate) use process_environment::NativeProcessEnvironment;
pub(crate) use process_models::NativeProcessModels;
pub(crate) use profile_sources::ProfileConversationSources;
pub(crate) use progress_publisher::NativeProgressPublisher;
pub(crate) use project_plan::NativeAcceptedPlanProducer;
pub(crate) use prompt_clock::NativePromptClock;
#[cfg(unix)]
pub use public_cli::{recognizes as native_public_cli_recognizes, run as run_native_public_cli};
pub(crate) use runtime::{NativeAgentRuntime, NativeRuntimePaths};
#[cfg(unix)]
pub use service_cli::{recognizes as native_service_cli_recognizes, run_native_service_cli};
pub(crate) use service_configuration::{NativeServiceConfiguration, require_model_ref};
#[cfg(unix)]
pub use settings_cli::{
    recognizes as native_settings_cli_recognizes, run as run_native_settings_cli,
};
#[cfg(unix)]
pub use skills_cli::{NativeSkillCliResult, run_native_skills_cli};
#[cfg(unix)]
pub use status_cli::{recognizes as native_status_cli_recognizes, run_native_status_cli};
pub(crate) use storage_bootstrap::prepare_btcc_storage;
#[cfg(unix)]
pub use transport_cli::{
    recognizes as native_transport_cli_recognizes, run as run_native_transport_cli,
};
#[cfg(unix)]
pub use update_cli::{recognizes as native_update_cli_recognizes, run as run_native_update_cli};
#[cfg(unix)]
pub use web_access_cli::{
    recognizes as native_web_access_cli_recognizes, run as run_native_web_access_cli,
};
#[cfg(unix)]
pub use work_cli::{
    NativeWorkCliResult, recognizes as native_work_cli_recognizes, run as run_native_work_cli,
};
pub(crate) use work_streams::NativeWorkStreams;
#[cfg(unix)]
pub(crate) use worker_profiles::NativeWorkerProfileReader;
pub(crate) use zai_vision::{NativeZaiVisionCapability, catalog_for_visual_admission};

use std::time::{Duration, SystemTime};

use crate::js_date as date;
use chrono::{DateTime, Datelike, Timelike, Utc};
use uuid::Uuid;

use crate::conversation::ConversationIdentityClock;
use crate::gateway::AppIdentityClock;
use crate::workspace::WorkspaceCode;
use crate::workspace::{WorkspaceClock, WorkspaceError, WorkspaceResult};

pub(crate) struct SystemIdentity;

impl crate::models::ProviderClock for SystemIdentity {
    fn now_epoch_millis(&self) -> i64 {
        crate::models::ModelConfigurationClock::now_epoch_millis(self)
    }
}

#[cfg(unix)]
impl crate::profile::ProfileHostFacts for SystemIdentity {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn new_uuid(&self) -> String {
        Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        crate::models::ModelConfigurationClock::now_epoch_millis(self)
    }
    fn now_iso(&self) -> String {
        iso_timestamp(SystemTime::now())
    }
    fn process_status(&self, pid: f64) -> crate::coordination::CognitionProcessStatus {
        coordination::profile_process_status(pid)
    }
}

impl crate::models::ModelConfigurationClock for SystemIdentity {
    fn now_iso(&self) -> String {
        iso_timestamp(SystemTime::now())
    }
    fn now_epoch_millis(&self) -> i64 {
        let now: DateTime<Utc> = SystemTime::now().into();
        now.timestamp_millis()
    }
}

impl WorkspaceClock for SystemIdentity {
    fn now_epoch_millis(&self) -> i64 {
        let now: DateTime<Utc> = SystemTime::now().into();
        now.timestamp_millis()
    }

    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        date::parse_iso_millis(value)
    }

    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        date::format_iso_millis(value).ok_or_else(|| {
            WorkspaceError::new(
                WorkspaceCode::WorkspaceInvalidTime,
                "Invalid session revision timestamp",
            )
        })
    }
}

impl ConversationIdentityClock for SystemIdentity {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", Uuid::new_v4())
    }

    fn now_iso(&self) -> String {
        iso_timestamp(SystemTime::now())
    }
}

impl AppIdentityClock for SystemIdentity {
    fn new_uuid(&self) -> String {
        Uuid::new_v4().to_string()
    }

    fn now_iso(&self) -> String {
        iso_timestamp(SystemTime::now())
    }

    fn iso_after_millis(&self, millis: u64) -> String {
        iso_timestamp(SystemTime::now() + Duration::from_millis(millis))
    }
}

fn iso_timestamp(time: SystemTime) -> String {
    let date: DateTime<Utc> = time.into();
    let year = date.year();
    // Date.toISOString uses six year digits with an explicit sign outside
    // 0000..9999. RFC3339's formatter uses a different extended-year width.
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_time_matches_js_iso_at_millisecond_and_calendar_boundaries() {
        for (millis, expected) in [
            (-1_i64, "1969-12-31T23:59:59.999Z"),
            (0, "1970-01-01T00:00:00.000Z"),
            (951_782_400_123, "2000-02-29T00:00:00.123Z"),
            (253_402_300_800_000, "+010000-01-01T00:00:00.000Z"),
            (-62_167_219_200_000, "0000-01-01T00:00:00.000Z"),
            (-62_198_755_200_000, "-000001-01-01T00:00:00.000Z"),
        ] {
            let time = if millis < 0 {
                SystemTime::UNIX_EPOCH - Duration::from_millis(millis.unsigned_abs())
            } else {
                SystemTime::UNIX_EPOCH
                    + Duration::from_millis(u64::try_from(millis).unwrap_or_default())
            };
            assert_eq!(iso_timestamp(time), expected);
        }
    }
}
