//! Composition of the agent process: the host wires every domain crate together.
//!
//! [`cli`] parses the command line into a [`cli::command::Command`]; [`runtime`]
//! builds the long-lived domain services; [`app`] serves the App gateway over
//! them; [`guided`] assembles guided turns (tools, prompts, journals); [`service`]
//! manages the background service; [`memory_jobs`] and [`embedding`] run memory
//! maintenance and the embedding worker; [`automation`] runs scheduled work.
//!
//! The shared system clock and UUID generator here retain no Turn/session state. Domain
//! ports remain explicit; domains do not depend on this composition module.

pub(crate) mod build_info;
mod error;
mod installation;
mod mcp;
mod oauth_callback;
pub(crate) use crate::host::guided::tool_artifact::ToolArtifactReader;
pub(crate) use butler_memory::cognition::MemorySourceReader;
mod runtime;

pub(crate) use crate::host::app::monitoring::AppMonitoring;
pub(crate) use crate::host::app::runtime_ports::{
    AppAdmission, AppApprovalClaimsAdapter, AppAssets, AppBranchConversations,
    AppBranchSummarizerAdapter, AppContextRead, AppIngress, AppModelCatalog, AppPersonalization,
    AppQueueOwnerLivenessAdapter, AppReadiness, AppSessionProgress, AppSessionWorkspaces,
    AppSettingsFactsAdapter, AppSettingsMutation,
};
pub(crate) use crate::host::app::server::{AppServer, AppServerOwners};
pub(crate) use crate::host::app::subsessions::AppSubsessions;
pub(crate) use crate::host::guided::activity::GuidedActivity;
pub(crate) use crate::host::guided::authority_handoff::AuthorityHandoff;
pub(crate) use crate::host::guided::catalog::GuidedCatalog;
pub(crate) use crate::host::guided::cognition_prompt::CognitionPrompt;
pub(crate) use crate::host::guided::factory::GuidedTurnFactoryAdapter;
pub(crate) use crate::host::guided::file_effects::GuidedFileEffects;
pub(crate) use crate::host::guided::journal::GuidedJournal;
pub(crate) use crate::host::guided::preparation::{GuidedPreparation, PreparedNativeGuidedTurn};
pub(crate) use crate::host::guided::prompt::{
    GuidedPrompt, GuidedTextState, resolve_guided_response_language,
};
pub(crate) use crate::host::guided::registered_edit::RegisteredEdit;
pub(crate) use crate::host::guided::steering::GuidedSteering;
use crate::host::guided::tools::MonitoringReaders;
pub(crate) use crate::host::guided::tools::{GuidedToolBinding, GuidedTools};
pub(crate) use crate::host::guided::work::GuidedWorkAdapter;
pub(crate) use crate::host::guided::work_tools::GuidedWorkTools;
pub(crate) use crate::host::service::conversation_observer::ConversationObserver;
pub(crate) use butler_runtime::capabilities::{RegisteredWrite, RegisteredWriteContext};
mod app;
mod automation;
pub(crate) mod cli;
mod embedding;
mod guided;
mod memory_jobs;
mod service;
mod time;
pub(crate) use crate::host::time::date_parser::DateParser;

pub(crate) use crate::host::app::gateway_lifecycle::ActiveAppEndpoint;
pub(crate) use crate::host::embedding::owner::EmbeddingOwner;
pub(crate) use crate::host::guided::tool_output::open_tool_output;

pub(crate) use crate::host::guided::active_plan::AcceptedPlanProducer;
pub(crate) use crate::host::guided::vision::{ZaiVisionCapability, catalog_for_visual_admission};
pub(crate) use crate::host::guided::work_streams::WorkStreams;
pub(crate) use crate::host::guided::worker_profiles::AppWorkerProfileReader;
pub(crate) use crate::host::memory_jobs::profile_sources::ProfileConversationSources;
pub(crate) use crate::host::runtime::environment::ProcessEnvironment;
pub(crate) use crate::host::runtime::models::ProcessModels;
pub(crate) use crate::host::runtime::storage_bootstrap::prepare_btcc_storage;
pub(crate) use crate::host::service::configuration::{ServiceConfiguration, require_model_ref};
pub(crate) use crate::host::service::progress_publisher::ProgressPublisher;
pub(crate) use crate::host::time::prompt_clock::SystemPromptClock;
pub(crate) use error::HostError;
pub(crate) use installation::ResolvedInstallation;
pub(crate) use runtime::{AgentRuntime, RuntimePaths};

use std::time::{Duration, SystemTime};

use butler_core::js_date as date;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use butler_gateway::gateway::AppIdentityClock;
use butler_turn::conversation::ConversationIdentityClock;
use butler_turn::workspace::{WorkspaceClock, WorkspaceCode, WorkspaceError, WorkspaceResult};

pub(crate) struct SystemIdentity;

impl butler_models::models::ProviderClock for SystemIdentity {
    fn now_epoch_millis(&self) -> i64 {
        butler_models::models::ModelConfigurationClock::now_epoch_millis(self)
    }
}

impl butler_memory::profile::ProfileHostFacts for SystemIdentity {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn new_uuid(&self) -> String {
        Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        butler_models::models::ModelConfigurationClock::now_epoch_millis(self)
    }
    fn now_iso(&self) -> String {
        date::iso_from_system_time(SystemTime::now())
    }
    fn process_status(&self, pid: f64) -> butler_memory::coordination::CognitionProcessStatus {
        crate::host::runtime::process_probe::profile_process_status(pid)
    }
}

impl butler_models::models::ModelConfigurationClock for SystemIdentity {
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
