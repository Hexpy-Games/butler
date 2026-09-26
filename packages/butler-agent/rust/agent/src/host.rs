//! Native host adapters shared by the composed domain owners.
//!
//! The system clock and UUID generator retain no Turn/session state. Domain
//! ports remain explicit; domains do not depend on this composition module.

mod installation;
#[cfg(unix)]
mod mcp;
pub(crate) use crate::host::guided::tool_artifact::NativeToolArtifactReader;
pub(crate) use crate::host::memory_jobs::source::NativeMemorySourceReader;
mod runtime;

#[cfg(unix)]
pub(crate) use crate::host::app::monitoring::NativeAppMonitoring;
#[cfg(unix)]
pub(crate) use crate::host::app::runtime_ports::NativeAppAdmission;
pub(crate) use crate::host::app::runtime_ports::NativeAppApprovalClaims;
pub(crate) use crate::host::app::runtime_ports::NativeAppAssets;
pub(crate) use crate::host::app::runtime_ports::NativeAppBranchConversations;
pub(crate) use crate::host::app::runtime_ports::NativeAppBranchSummarizer;
pub(crate) use crate::host::app::runtime_ports::NativeAppContextRead;
pub(crate) use crate::host::app::runtime_ports::NativeAppIngress;
pub(crate) use crate::host::app::runtime_ports::NativeAppModelCatalog;
pub(crate) use crate::host::app::runtime_ports::NativeAppPersonalization;
pub(crate) use crate::host::app::runtime_ports::NativeAppQueueOwnerLiveness;
pub(crate) use crate::host::app::runtime_ports::NativeAppReadiness;
pub(crate) use crate::host::app::runtime_ports::NativeAppSessionProgress;
pub(crate) use crate::host::app::runtime_ports::NativeAppSessionWorkspaces;
pub(crate) use crate::host::app::runtime_ports::NativeAppSettingsFacts;
pub(crate) use crate::host::app::runtime_ports::NativeAppSettingsMutation;
#[cfg(unix)]
pub(crate) use crate::host::app::server::NativeAppServer;
pub(crate) use crate::host::app::subsessions::NativeAppSubsessions;
pub(crate) use crate::host::guided::activity::NativeGuidedActivity;
pub(crate) use crate::host::guided::authority_handoff::NativeAuthorityHandoff;
pub(crate) use crate::host::guided::catalog::NativeGuidedCatalog;
pub(crate) use crate::host::guided::cognition_prompt::NativeCognitionPrompt;
pub(crate) use crate::host::guided::factory::NativeGuidedTurnFactory;
pub(crate) use crate::host::guided::file_effects::NativeGuidedFileEffects;
pub(crate) use crate::host::guided::journal::NativeGuidedJournal;
pub(crate) use crate::host::guided::preparation::NativeGuidedPreparation;
pub(crate) use crate::host::guided::preparation::PreparedNativeGuidedTurn;
pub(crate) use crate::host::guided::prompt::GuidedTextState;
pub(crate) use crate::host::guided::prompt::NativeGuidedPrompt;
pub(crate) use crate::host::guided::prompt::resolve_guided_response_language;
pub(crate) use crate::host::guided::registered_edit::NativeRegisteredEdit;
pub(crate) use crate::host::guided::registered_write::NativeRegisteredWrite;
pub(crate) use crate::host::guided::registered_write::RegisteredWriteContext;
pub(crate) use crate::host::guided::steering::NativeGuidedSteering;
pub(crate) use crate::host::guided::tools::GuidedToolBinding;
use crate::host::guided::tools::MonitoringReaders;
pub(crate) use crate::host::guided::tools::NativeGuidedTools;
pub(crate) use crate::host::guided::work::NativeGuidedWork;
pub(crate) use crate::host::guided::work_tools::NativeGuidedWorkTools;
pub(crate) use crate::host::service::conversation_observer::NativeConversationObserver;
mod app;
mod automation;
mod cli;
mod embedding;
mod guided;
mod memory_jobs;
mod service;
mod time;
pub(crate) use crate::host::automation::queue::NativeAutomationQueue;
pub(crate) use crate::host::automation::runtime::open_automation_service;
pub(crate) use crate::host::time::date_parser::NativeDateParser;

#[cfg(unix)]
pub(crate) use crate::host::app::gateway_lifecycle::NativeActiveAppEndpoint;
#[cfg(unix)]
pub(crate) use crate::host::embedding::owner::NativeEmbeddingOwner;
#[cfg(unix)]
pub use crate::host::embedding::worker::run as run_private_embedding_worker;
pub(crate) use crate::host::guided::tool_output::native_tool_output;

#[cfg(unix)]
pub use crate::host::cli::automation::recognizes as native_automation_cli_recognizes;
pub use crate::host::cli::automation::run as run_native_automation_cli;
#[cfg(unix)]
pub use crate::host::cli::cognition::recognizes as native_cognition_operator_cli_recognizes;
pub use crate::host::cli::cognition::run as run_native_cognition_operator_cli;
#[cfg(unix)]
pub use crate::host::cli::consolidation::NativeConsolidationCliResult;
pub use crate::host::cli::consolidation::run_native_consolidation_cli;
#[cfg(unix)]
pub use crate::host::cli::context::recognizes as native_context_cli_recognizes;
pub use crate::host::cli::context::run as run_native_context_cli;
#[cfg(unix)]
pub use crate::host::cli::conversation_recovery::recognizes as native_conversation_recovery_cli_recognizes;
pub use crate::host::cli::conversation_recovery::run as run_native_conversation_recovery_cli;
#[cfg(unix)]
pub use crate::host::cli::doctor::recognizes as native_doctor_cli_recognizes;
pub use crate::host::cli::doctor::run as run_native_doctor_cli;
#[cfg(unix)]
pub use crate::host::cli::gateway::recognizes as native_gateway_cli_recognizes;
pub use crate::host::cli::gateway::run as run_native_gateway_cli;
#[cfg(unix)]
pub use crate::host::cli::oauth_login::run_native_oauth_login;
#[cfg(unix)]
pub use crate::host::cli::observability::recognizes as native_observability_cli_recognizes;
pub use crate::host::cli::observability::run as run_native_observability_cli;
#[cfg(unix)]
pub use crate::host::cli::personalization::recognizes as native_personalization_cli_recognizes;
pub use crate::host::cli::personalization::run as run_native_personalization_cli;
#[cfg(unix)]
pub use crate::host::cli::public::recognizes as native_public_cli_recognizes;
pub use crate::host::cli::public::run as run_native_public_cli;
#[cfg(unix)]
pub use crate::host::cli::service::recognizes as native_service_cli_recognizes;
pub use crate::host::cli::service::run_native_service_cli;
#[cfg(unix)]
pub use crate::host::cli::settings::recognizes as native_settings_cli_recognizes;
pub use crate::host::cli::settings::run as run_native_settings_cli;
#[cfg(unix)]
pub use crate::host::cli::skills::NativeSkillCliResult;
pub use crate::host::cli::skills::run_native_skills_cli;
#[cfg(unix)]
pub use crate::host::cli::status::recognizes as native_status_cli_recognizes;
pub use crate::host::cli::status::run_native_status_cli;
#[cfg(unix)]
pub use crate::host::cli::transport::recognizes as native_transport_cli_recognizes;
pub use crate::host::cli::transport::run as run_native_transport_cli;
#[cfg(unix)]
pub use crate::host::cli::update::recognizes as native_update_cli_recognizes;
pub use crate::host::cli::update::run as run_native_update_cli;
#[cfg(unix)]
pub use crate::host::cli::web_access::recognizes as native_web_access_cli_recognizes;
pub use crate::host::cli::web_access::run as run_native_web_access_cli;
#[cfg(unix)]
pub use crate::host::cli::work::NativeWorkCliResult;
pub use crate::host::cli::work::recognizes as native_work_cli_recognizes;
pub use crate::host::cli::work::run as run_native_work_cli;
pub(crate) use crate::host::guided::active_plan::NativeAcceptedPlanProducer;
pub(crate) use crate::host::guided::vision::NativeZaiVisionCapability;
pub(crate) use crate::host::guided::vision::catalog_for_visual_admission;
pub(crate) use crate::host::guided::work_streams::NativeWorkStreams;
#[cfg(unix)]
pub(crate) use crate::host::guided::worker_profiles::NativeWorkerProfileReader;
#[cfg(unix)]
pub use crate::host::memory_jobs::initialize::run as run_native_memory_initialize_cli;
#[cfg(unix)]
pub use crate::host::memory_jobs::maintain::run as run_native_memory_maintain_cli;
pub(crate) use crate::host::memory_jobs::profile_sources::ProfileConversationSources;
#[cfg(unix)]
pub use crate::host::memory_jobs::rebuild::run as run_native_memory_rebuild_cli;
pub(crate) use crate::host::runtime::environment::NativeProcessEnvironment;
pub(crate) use crate::host::runtime::models::NativeProcessModels;
pub(crate) use crate::host::runtime::storage_bootstrap::prepare_btcc_storage;
pub(crate) use crate::host::service::configuration::NativeServiceConfiguration;
pub(crate) use crate::host::service::configuration::require_model_ref;
#[cfg(unix)]
pub use crate::host::service::entrypoint::run_native_service;
pub(crate) use crate::host::service::progress_publisher::NativeProgressPublisher;
pub(crate) use crate::host::time::prompt_clock::NativePromptClock;
#[cfg(unix)]
pub use installation::ResolvedInstallation;
#[cfg(unix)]
pub use mcp::{recognizes as native_mcp_cli_recognizes, run as run_native_mcp_cli};
pub(crate) use runtime::{NativeAgentRuntime, NativeRuntimePaths};

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
        crate::host::runtime::process_probe::profile_process_status(pid)
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
