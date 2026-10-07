use super::{AccessMode, ApprovalExemptAction};
use crate::btcc::ApprovalRisk;
use butler_core::tool_protocol::ToolName;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityKind {
    Exempt(ApprovalExemptAction),
    InternalRead,
    FileRead,
    CommandObservation { sandboxed: bool },
    CommandMutation { sandbox: CommandSandbox },
    Network,
    Connector,
    FileEdit,
    Schedule,
    SettingsWrite,
    ProjectRecord,
    CrossConversation,
    ButlerOutput,
    FullOnly(FullOnlyAction),
    OtherEffect,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandSandbox {
    None,
    ProjectWrite,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FullOnlyAction {
    ServiceRestart,
    GitWorktree,
    MemoryForget,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TargetScope {
    NoTarget,
    ProjectFolder,
    Outside,
    Protected,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnTaint {
    Clean,
    External,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccessRequest {
    pub kind: CapabilityKind,
    pub risk: ApprovalRisk,
    pub scope: TargetScope,
    pub taint: TurnTaint,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantUse {
    Honor,
    Ignore,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyReason {
    ReadOnly,
    FullAccessRequired,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessDecision {
    Allow,
    Ask(GrantUse),
    Deny(DenyReason),
}

/// PR1 boundary: taint and ProjectWrite are reserved for PR2.
pub fn decide(mode: &AccessMode, request: AccessRequest) -> AccessDecision {
    use AccessDecision::*;
    use CapabilityKind::*;
    if *mode == AccessMode::FullAccess {
        return Allow;
    }
    if matches!(request.kind, FullOnly(_)) {
        return Deny(DenyReason::FullAccessRequired);
    }
    if *mode == AccessMode::ReadOnly {
        return if matches!(
            request.kind,
            InternalRead | FileRead | CommandObservation { .. }
        ) {
            Allow
        } else {
            Deny(DenyReason::ReadOnly)
        };
    }
    let project = request.scope == TargetScope::ProjectFolder;
    let first = *mode == AccessMode::AskExceptReads;
    match request.kind {
        Exempt(_) | InternalRead | ButlerOutput => Allow,
        FileRead if first && project => Allow,
        CommandObservation { sandboxed: true } if project => Allow,
        CommandObservation { sandboxed: false } | CommandMutation { .. }
            if first && project && request.risk == ApprovalRisk::Low =>
        {
            Allow
        }
        _ => Ask(GrantUse::Honor),
    }
}
pub fn needs_scope(mode: &AccessMode, kind: CapabilityKind) -> bool {
    match kind {
        CapabilityKind::FileRead | CapabilityKind::CommandMutation { .. } => {
            *mode == AccessMode::AskExceptReads
        }
        CapabilityKind::CommandObservation { .. } => mode.reviews_effects(),
        _ => false,
    }
}
impl CapabilityKind {
    pub fn of_call(name: &str, arguments: &Map<String, Value>, ledger_effect: bool) -> Self {
        use ToolName::*;
        let Some(tool) = ToolName::parse(name) else {
            return Self::OtherEffect;
        };
        if let Some(action) = ApprovalExemptAction::of_tool(name) {
            return Self::Exempt(action);
        }
        if ledger_effect {
            return Self::ProjectRecord;
        }
        match tool {
            ForgetExplicitMemory => Self::FullOnly(FullOnlyAction::MemoryForget),
            RequestServiceRestart => Self::FullOnly(FullOnlyAction::ServiceRestart),
            BindSessionGitWorktree => Self::FullOnly(FullOnlyAction::GitWorktree),
            ReadFile | ListFiles | GrepFiles => Self::FileRead,
            RunCommand => match arguments.get("state_effect").and_then(Value::as_str) {
                None | Some("read_only" | "validation") => Self::CommandObservation {
                    sandboxed: butler_platform::command_sandbox::READ_ONLY_SANDBOX,
                },
                Some("remote_observation") => Self::Network,
                Some("mutation") => Self::CommandMutation {
                    sandbox: CommandSandbox::None,
                },
                _ => Self::OtherEffect,
            },
            CallMcpTool => Self::Connector,
            WriteFile | EditFile => Self::FileEdit,
            CreateAutomation | UpdateAutomation | DeleteAutomation | RunDueAutomations => {
                Self::Schedule
            }
            SetWallpaper | SaveWallpaperModule => Self::SettingsWrite,
            StartTopicConversation => Self::CrossConversation,
            OutputPublish => Self::ButlerOutput,
            _ => Self::InternalRead,
        }
    }
}
/// Unresolved shell evaluation must never inherit a project classification.
pub fn command_scope_unresolved(command: &str) -> bool {
    command.contains(['$', '`', '%', '!'])
        || command.split_ascii_whitespace().any(|word| {
            let word = word.trim_matches(['\'', '"']);
            word.starts_with('~')
                || (std::path::Path::new(word).is_absolute() && word.contains(['*', '?', '[']))
        })
}
/// Risk is shared with the exact-action approval card.
pub fn command_access_risk(command: &str) -> ApprovalRisk {
    crate::btcc::authority::approval::command_risk(command)
}
