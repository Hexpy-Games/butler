//! The names of the built-in tools the model can call.
//!
//! Tool names are part of the model-facing wire contract (tool definitions,
//! persisted tool calls and journals), so they are spelled exactly once, here.

/// Declares [`ToolName`] from `Variant = "wire_name"` rows.
macro_rules! tool_names {
    ($($variant:ident = $wire:literal,)+) => {
        /// A built-in tool, by its wire name.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum ToolName {
            $(
                #[doc = concat!("`", $wire, "`")]
                $variant,
            )+
        }

        impl ToolName {
            /// Every built-in tool, in wire-name order.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            /// The wire name.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            /// The built-in tool with this wire name, if any.
            pub fn parse(name: &str) -> Option<Self> {
                match name {
                    $($wire => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

tool_names! {
    AnalyzeAttachedImage = "analyze_attached_image",
    BindSessionGitWorktree = "bind_session_git_worktree",
    CallMcpTool = "call_mcp_tool",
    CancelSteward = "cancel_steward",
    CompleteProjectWork = "complete_project_work",
    ContinueWork = "continue_work",
    ControlWork = "control_work",
    CreateAutomation = "create_automation",
    DelegateToSteward = "delegate_to_steward",
    DelegateToWorker = "delegate_to_worker",
    DeleteAutomation = "delete_automation",
    EditFile = "edit_file",
    GetContextMonitor = "get_context_monitor",
    GetMemoryHealth = "get_memory_health",
    GetUsageMonitor = "get_usage_monitor",
    GetWorkDashboard = "get_work_dashboard",
    GrepFiles = "grep_files",
    IngestTaskMemory = "ingest_task_memory",
    InspectProjectStatus = "inspect_project_status",
    ListAutomations = "list_automations",
    ListConversationSessions = "list_conversation_sessions",
    ListFiles = "list_files",
    ListMcpCapabilities = "list_mcp_capabilities",
    ListOperationResults = "list_operation_results",
    ListSkills = "list_skills",
    ListTodoList = "list_todo_list",
    ListToolCapabilities = "list_tool_capabilities",
    ListWallpapers = "list_wallpapers",
    ListWorkStreams = "list_work_streams",
    ProjectLedgerAttemptFail = "project_ledger_attempt_fail",
    ProjectLedgerAttemptStart = "project_ledger_attempt_start",
    ProjectLedgerAttemptSucceed = "project_ledger_attempt_succeed",
    ProjectLedgerCheck = "project_ledger_check",
    ProjectLedgerCreate = "project_ledger_create",
    ProjectLedgerIndex = "project_ledger_index",
    ProjectLedgerList = "project_ledger_list",
    ProjectLedgerRender = "project_ledger_render",
    ProjectLedgerShow = "project_ledger_show",
    ProjectLedgerStatus = "project_ledger_status",
    ProjectLedgerTaskComplete = "project_ledger_task_complete",
    ProjectLedgerTaskUpdate = "project_ledger_task_update",
    ProjectLedgerUpdate = "project_ledger_update",
    ProjectLedgerWorkComplete = "project_ledger_work_complete",
    ProjectLedgerWorkUpdate = "project_ledger_work_update",
    QueryMemory = "query_memory",
    QueryProjectWork = "query_project_work",
    ReadConversationContext = "read_conversation_context",
    ReadConversationSession = "read_conversation_session",
    ReadFile = "read_file",
    ReadMcpResource = "read_mcp_resource",
    ReadOperationResults = "read_operation_results",
    ReadProjectSource = "read_project_source",
    ReadToolEvidenceArtifact = "read_tool_evidence_artifact",
    ReadToolOutputArtifact = "read_tool_output_artifact",
    RecallMemory = "recall_memory",
    RecordWorkCheckpoint = "record_work_checkpoint",
    RecordWorkDisposition = "record_work_disposition",
    RecordWorkReview = "record_work_review",
    RenderProjectDashboard = "render_project_dashboard",
    ReplaceWorkPlan = "replace_work_plan",
    RequestServiceRestart = "request_service_restart",
    RunCommand = "run_command",
    RunDueAutomations = "run_due_automations",
    SaveWallpaperModule = "save_wallpaper_module",
    SetWallpaper = "set_wallpaper",
    StartTopicConversation = "start_topic_conversation",
    StartWork = "start_work",
    SteerSteward = "steer_steward",
    SteerWorker = "steer_worker",
    SummarizeUserProfile = "summarize_user_profile",
    ToolCall = "tool_call",
    ToolDescribe = "tool_describe",
    ToolSearch = "tool_search",
    TransformPublicDataTable = "transform_public_data_table",
    UpdateExplicitMemory = "update_explicit_memory",
    UpdateAutomation = "update_automation",
    UpdateOnboardingProfile = "update_onboarding_profile",
    UpdateTodoList = "update_todo_list",
    UpdateWorkStreamState = "update_work_stream_state",
    WaitForWorker = "wait_for_worker",
    WebRead = "web_read",
    WebSearch = "web_search",
    WriteFile = "write_file",
}

impl std::fmt::Display for ToolName {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl PartialEq<ToolName> for str {
    fn eq(&self, other: &ToolName) -> bool {
        self == other.as_str()
    }
}

impl PartialEq<ToolName> for &str {
    fn eq(&self, other: &ToolName) -> bool {
        *self == other.as_str()
    }
}

impl PartialEq<ToolName> for &String {
    fn eq(&self, other: &ToolName) -> bool {
        *self == other.as_str()
    }
}

impl PartialEq<ToolName> for String {
    fn eq(&self, other: &ToolName) -> bool {
        self == other.as_str()
    }
}

impl PartialEq<ToolName> for std::borrow::Cow<'_, str> {
    fn eq(&self, other: &ToolName) -> bool {
        self.as_ref() == other.as_str()
    }
}
