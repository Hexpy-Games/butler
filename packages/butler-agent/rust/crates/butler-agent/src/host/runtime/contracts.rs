use std::{path::PathBuf, sync::Arc};

use crate::btcc::{
    Btcc, BtccError, BtccHost, ContextCompactionRepository, PrincipalAuthority,
    SessionWorkRepository, StorageProgressPublication,
};
use crate::context::ContextBudgetOwner;
use crate::conversation::AgentConversationStore;
use crate::host::memory_jobs::context_maintenance::ContextMaintenance;
use crate::project_ledger::ProjectLedger;
use crate::skills::Skills;
use crate::workspace::{SessionBindingStore, SessionWorkspaceRecovery, SessionWorktrees};
use butler_core::locale::LocaleCollation;

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
    pub restart_tool_journal: Arc<crate::btcc::ToolJournalRepository>,
    pub restart_effect_journal: Arc<crate::btcc::StorageEffectJournal>,
    pub subsessions: Arc<crate::btcc::SubsessionService>,
    pub work_streams: Arc<WorkStreams>,
    pub skills: Arc<Skills>,
    pub mcp_client: Arc<crate::mcp_client::McpClient>,
    pub context_maintenance: Arc<ContextMaintenance>,
    pub profile: Arc<crate::profile::ProfileService>,
    pub(super) host: BtccHost,
}

impl AgentRuntime {
    pub(crate) async fn close(self) -> Result<(), BtccError> {
        self.host.close().await
    }
}
