use std::{path::PathBuf, sync::Arc};

use crate::host::memory_jobs::context_maintenance::ContextMaintenance;
use butler_core::locale::LocaleCollation;
use butler_ledger::project_ledger::ProjectLedger;
use butler_runtime::context::ContextBudgetOwner;
use butler_runtime::skills::Skills;
use butler_turn::btcc::Btcc;
use butler_turn::btcc::BtccError;
use butler_turn::btcc::BtccHost;
use butler_turn::btcc::ContextCompactionRepository;
use butler_turn::btcc::PrincipalAuthority;
use butler_turn::btcc::SessionWorkRepository;
use butler_turn::btcc::StorageProgressPublication;
use butler_turn::conversation::AgentConversationStore;
use butler_turn::workspace::SessionBindingStore;
use butler_turn::workspace::SessionWorkspaceRecovery;
use butler_turn::workspace::SessionWorktrees;

use super::super::{ProcessModels, WorkStreams};

pub(crate) struct RuntimePaths {
    pub data_root: PathBuf,
    pub installation_root: PathBuf,
    pub executable_path: PathBuf,
    pub resource_root: PathBuf,
    pub workspace_root: PathBuf,
}

/// Ingress holds this owner, admits via BTCC, then awaits close before process exit.
pub(crate) struct AgentRuntime {
    pub btcc: Btcc,
    pub bindings: SessionBindingStore,
    pub models: ProcessModels,
    pub context_budget: Arc<ContextBudgetOwner>,
    pub context_compactions: ContextCompactionRepository,
    pub collation: Arc<LocaleCollation>,
    pub progress: StorageProgressPublication,
    pub conversations: Arc<AgentConversationStore>,
    pub image_files: Arc<crate::gateway::AppImageFiles>,
    pub authority: Arc<PrincipalAuthority>,
    pub project_ledger: ProjectLedger,
    pub session_work: Arc<SessionWorkRepository>,
    pub session_worktrees: SessionWorktrees,
    pub workspace_recovery: SessionWorkspaceRecovery,
    pub inbound_queue: Arc<crate::gateway::InboundQueue>,
    pub restart_tool_journal: Arc<butler_turn::btcc::ToolJournalRepository>,
    pub restart_effect_journal: Arc<butler_turn::btcc::StorageEffectJournal>,
    pub subsessions: Arc<butler_turn::btcc::SubsessionService>,
    pub work_streams: Arc<WorkStreams>,
    pub skills: Arc<Skills>,
    pub mcp_client: Arc<butler_models::mcp_client::McpClient>,
    pub context_maintenance: Arc<ContextMaintenance>,
    pub profile: Arc<butler_memory::profile::ProfileService>,
    pub(super) host: BtccHost,
}

impl AgentRuntime {
    pub(crate) async fn close(self) -> Result<(), BtccError> {
        self.host.close().await
    }
}
