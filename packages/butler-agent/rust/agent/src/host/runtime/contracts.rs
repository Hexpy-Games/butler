use std::{path::PathBuf, sync::Arc};

use super::super::context_maintenance::ContextMaintenance;
use crate::btcc::{
    Btcc, BtccError, BtccHost, ContextCompactionRepository, NativePrincipalAuthority,
    SessionWorkRepository, StorageProgressPublication,
};
use crate::context::ContextBudgetOwner;
use crate::conversation::AgentConversationStore;
use crate::locale::LocaleCollation;
use crate::project_ledger::NativeProjectLedger;
use crate::skills::NativeSkills;
use crate::workspace::{
    NativeSessionWorkspaceRecovery, NativeSessionWorktrees, SessionBindingStore,
};

use super::super::{NativeProcessModels, NativeWorkStreams};

pub(crate) struct NativeRuntimePaths {
    pub data_root: PathBuf,
    pub installation_root: PathBuf,
    pub executable_path: PathBuf,
    pub resource_root: PathBuf,
    pub workspace_root: PathBuf,
}

/// Ingress holds this owner, admits via BTCC, then awaits close before process exit.
pub(crate) struct NativeAgentRuntime {
    pub btcc: Btcc,
    pub bindings: SessionBindingStore,
    pub models: NativeProcessModels,
    pub context_budget: Arc<ContextBudgetOwner>,
    pub context_compactions: ContextCompactionRepository,
    pub collation: Arc<LocaleCollation>,
    pub progress: StorageProgressPublication,
    pub conversations: Arc<AgentConversationStore>,
    pub image_files: Arc<crate::gateway::NativeAppImageFiles>,
    pub authority: Arc<NativePrincipalAuthority>,
    pub project_ledger: NativeProjectLedger,
    pub session_work: Arc<SessionWorkRepository>,
    pub session_worktrees: NativeSessionWorktrees,
    pub workspace_recovery: NativeSessionWorkspaceRecovery,
    pub inbound_queue: Arc<crate::gateway::NativeInboundQueue>,
    pub restart_tool_journal: Arc<crate::btcc::ToolJournalRepository>,
    pub restart_effect_journal: Arc<crate::btcc::StorageEffectJournal>,
    pub subsessions: Arc<crate::btcc::NativeSubsessionService>,
    pub work_streams: Arc<NativeWorkStreams>,
    pub skills: Arc<NativeSkills>,
    pub mcp_client: Arc<crate::mcp_client::NativeMcpClient>,
    pub context_maintenance: Arc<ContextMaintenance>,
    pub profile: Arc<crate::profile::ProfileService>,
    pub(super) host: BtccHost,
}

impl NativeAgentRuntime {
    pub(crate) async fn close(self) -> Result<(), BtccError> {
        self.host.close().await
    }
}
