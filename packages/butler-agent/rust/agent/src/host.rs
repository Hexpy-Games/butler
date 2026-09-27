//! Native host adapters shared by the composed domain owners.
//!
//! The system clock and UUID generator retain no Turn/session state. Domain
//! ports remain explicit; domains do not depend on this composition module.

mod error;
mod installation;
#[cfg(unix)]
mod mcp;
pub(crate) use crate::host::guided::tool_artifact::NativeToolArtifactReader;
pub(crate) use crate::host::memory_jobs::source::NativeMemorySourceReader;
mod runtime;

#[cfg(unix)]
pub(crate) use crate::host::app::monitoring::NativeAppMonitoring;
#[cfg(unix)]
pub(crate) use crate::host::app::runtime_ports::{
    NativeAppAdmission, NativeAppApprovalClaims, NativeAppAssets, NativeAppBranchConversations,
    NativeAppBranchSummarizer, NativeAppContextRead, NativeAppIngress, NativeAppModelCatalog,
    NativeAppPersonalization, NativeAppQueueOwnerLiveness, NativeAppReadiness,
    NativeAppSessionProgress, NativeAppSessionWorkspaces, NativeAppSettingsFacts,
    NativeAppSettingsMutation,
};
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
pub(crate) use crate::host::guided::preparation::{
    NativeGuidedPreparation, PreparedNativeGuidedTurn,
};
pub(crate) use crate::host::guided::prompt::{
    GuidedTextState, NativeGuidedPrompt, resolve_guided_response_language,
};
pub(crate) use crate::host::guided::registered_edit::NativeRegisteredEdit;
pub(crate) use crate::host::guided::registered_write::{
    NativeRegisteredWrite, RegisteredWriteContext,
};
pub(crate) use crate::host::guided::steering::NativeGuidedSteering;
pub(crate) use crate::host::guided::tools::GuidedToolBinding;
use crate::host::guided::tools::MonitoringReaders;
pub(crate) use crate::host::guided::tools::NativeGuidedTools;
pub(crate) use crate::host::guided::work::NativeGuidedWork;
pub(crate) use crate::host::guided::work_tools::NativeGuidedWorkTools;
pub(crate) use crate::host::service::conversation_observer::NativeConversationObserver;
mod app;
mod automation;
pub(crate) mod cli;
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
pub(crate) use crate::host::guided::tool_output::native_tool_output;

pub(crate) use crate::host::guided::active_plan::NativeAcceptedPlanProducer;
pub(crate) use crate::host::guided::vision::{
    NativeZaiVisionCapability, catalog_for_visual_admission,
};
pub(crate) use crate::host::guided::work_streams::NativeWorkStreams;
#[cfg(unix)]
pub(crate) use crate::host::guided::worker_profiles::NativeWorkerProfileReader;
pub(crate) use crate::host::memory_jobs::profile_sources::ProfileConversationSources;
pub(crate) use crate::host::runtime::environment::NativeProcessEnvironment;
pub(crate) use crate::host::runtime::models::NativeProcessModels;
pub(crate) use crate::host::runtime::storage_bootstrap::prepare_btcc_storage;
pub(crate) use crate::host::service::configuration::{
    NativeServiceConfiguration, require_model_ref,
};
pub(crate) use crate::host::service::progress_publisher::NativeProgressPublisher;
pub(crate) use crate::host::time::prompt_clock::NativePromptClock;
#[cfg(unix)]
pub(crate) use error::HostError;
pub(crate) use installation::ResolvedInstallation;
pub(crate) use runtime::{NativeAgentRuntime, NativeRuntimePaths};

use std::time::{Duration, SystemTime};

use crate::js_date as date;
use chrono::{DateTime, Utc};
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
        date::iso_from_system_time(SystemTime::now())
    }
    fn process_status(&self, pid: f64) -> crate::coordination::CognitionProcessStatus {
        crate::host::runtime::process_probe::profile_process_status(pid)
    }
}

impl crate::models::ModelConfigurationClock for SystemIdentity {
    fn now_iso(&self) -> String {
        date::iso_from_system_time(SystemTime::now())
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
        date::iso_from_system_time(SystemTime::now())
    }
}

impl AppIdentityClock for SystemIdentity {
    fn new_uuid(&self) -> String {
        Uuid::new_v4().to_string()
    }

    fn now_iso(&self) -> String {
        date::iso_from_system_time(SystemTime::now())
    }

    fn iso_after_millis(&self, millis: u64) -> String {
        date::iso_from_system_time(SystemTime::now() + Duration::from_millis(millis))
    }
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
            assert_eq!(date::iso_from_system_time(time), expected);
        }
    }
}
