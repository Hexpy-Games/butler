//! Tool-specific approval summaries.
use super::*;

pub(super) fn by_tool(facts: ApprovalFacts<'_>, tool: Option<ToolName>) -> AuthorityApproval {
    let (kind, target, risk) = match tool {
        Some(ToolName::WriteFile | ToolName::EditFile) => return file_edits(facts),
        Some(ToolName::ReadFile | ToolName::ListFiles | ToolName::GrepFiles) => {
            return file_reads(facts);
        }
        Some(ToolName::DeleteAutomation) => (
            ApprovalActionKind::ManageSchedule,
            ApprovalTargetKind::Schedule,
            ApprovalRisk::High,
        ),
        Some(ToolName::CreateAutomation | ToolName::RunDueAutomations) => (
            ApprovalActionKind::ManageSchedule,
            ApprovalTargetKind::Schedule,
            ApprovalRisk::Medium,
        ),
        Some(
            ToolName::ProjectLedgerCreate
            | ToolName::ProjectLedgerUpdate
            | ToolName::ProjectLedgerWorkUpdate
            | ToolName::ProjectLedgerWorkComplete
            | ToolName::CompleteProjectWork
            | ToolName::ProjectLedgerTaskUpdate
            | ToolName::ProjectLedgerTaskComplete
            | ToolName::ProjectLedgerAttemptStart
            | ToolName::ProjectLedgerAttemptSucceed
            | ToolName::ProjectLedgerAttemptFail,
        ) => (
            ApprovalActionKind::UpdateProject,
            ApprovalTargetKind::Project,
            ApprovalRisk::Low,
        ),
        _ => (
            ApprovalActionKind::Other,
            ApprovalTargetKind::Other,
            ApprovalRisk::High,
        ),
    };
    single(kind, target, facts.target, risk)
}
