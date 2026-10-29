//! Native executor registration, including specialized tool registries.
use super::{GuidedTools, browser, documents, image_gen};
use crate::host::GuidedWorkTools;
use butler_core::tool_protocol::ToolName;

impl GuidedTools {
    pub(crate) fn supports(name: &str) -> bool {
        connector(name)
            || builtin(name)
            || documents::supports(name)
            || browser::supports(name)
            || image_gen::supports(name)
            || GuidedWorkTools::is_work_tool(name)
            || crate::host::guided::project_tools::GuidedProjectTools::supports(name)
    }
}

fn builtin(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(
            ToolName::CanonRead
                | ToolName::CanonPropose
                | ToolName::AskUser
                | ToolName::ResolveAsk
                | ToolName::ReadFile
                | ToolName::RunCommand
                | ToolName::WriteFile
                | ToolName::OutputCheck
                | ToolName::OutputPublish
                | ToolName::DeliverFiles
                | ToolName::AnswerBlocks
                | ToolName::EditFile
                | ToolName::GrepFiles
                | ToolName::ReadToolOutputArtifact
                | ToolName::ReadToolEvidenceArtifact
                | ToolName::ListFiles
                | ToolName::ListSkills
                | ToolName::LoadSkill
                | ToolName::ReadSkillFile
                | ToolName::ListOperationResults
                | ToolName::ReadOperationResults
                | ToolName::QueryMemory
                | ToolName::RecallMemory
                | ToolName::IngestTaskMemory
                | ToolName::UpdateExplicitMemory
                | ToolName::ForgetExplicitMemory
                | ToolName::AnalyzeAttachedImage
                | ToolName::ReadConversationSession
                | ToolName::ListConversationSessions
                | ToolName::ReadConversationContext
                | ToolName::ToolSearch
                | ToolName::ToolDescribe
                | ToolName::ToolCall
                | ToolName::ListMcpCapabilities
                | ToolName::SummarizeUserProfile
                | ToolName::UpdateOnboardingProfile
                | ToolName::ReadProjectSource
                | ToolName::ProjectArtifacts
                | ToolName::BindSessionGitWorktree
                | ToolName::SwitchFolder
                | ToolName::StartTopicConversation
                | ToolName::RequestServiceRestart
                | ToolName::CallMcpTool
                | ToolName::ReadMcpResource
                | ToolName::DelegateToSteward
                | ToolName::DelegateToWorker
                | ToolName::SteerSteward
                | ToolName::SteerWorker
                | ToolName::CancelSteward
                | ToolName::WaitForWorker
                | ToolName::ReadPriorDelegation
                | ToolName::UpdateTodoList
                | ToolName::ListTodoList
                | ToolName::GetContextMonitor
                | ToolName::GetUsageMonitor
                | ToolName::GetMemoryHealth
                | ToolName::ListToolCapabilities
                | ToolName::ListWorkStreams
                | ToolName::UpdateWorkStreamState
                | ToolName::CreateAutomation
                | ToolName::UpdateAutomation
                | ToolName::ListAutomations
                | ToolName::DeleteAutomation
                | ToolName::RunDueAutomations
                | ToolName::WebSearch
                | ToolName::WebRead
                | ToolName::Browse
                | ToolName::ListWallpapers
                | ToolName::SetWallpaper
                | ToolName::SaveWallpaperModule
                | ToolName::BrowserHistorySearch
                | ToolName::LibrarySearch
                | ToolName::LibraryOrganize
        )
    )
}

fn connector(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(
            ToolName::ConnectorFetch
                | ToolName::ConnectorRuleList
                | ToolName::ConnectorRuleRemove
                | ToolName::ConnectorRuleSet
                | ToolName::ConnectorTriage
        )
    )
}
