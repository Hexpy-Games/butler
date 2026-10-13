use super::{AccessMode, ApprovalExemptAction};
use crate::btcc::ApprovalRisk;
use butler_core::tool_protocol::ToolName;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityKind {
    Exempt(ApprovalExemptAction),
    InternalRead,
    FileRead,
    CommandObservation {
        sandboxed: bool,
    },
    CommandMutation {
        sandbox: CommandSandbox,
    },
    Network,
    Connector,
    FileEdit,
    Schedule,
    SettingsWrite,
    ProjectRecord,
    CrossConversation,
    ButlerOutput,
    FullOnly(FullOnlyAction),
    /// Moving the session's working folder; its scope says whether the
    /// target stays within the consented folder or its repository.
    FolderSwitch,
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
pub use crate::workspace::TargetScope;
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

/// The one access decision (spec-permission-tiers §1.2). Pure and O(1).
///
/// Auto ("ask only for risky actions") extends Ask first: project edits,
/// project-sandboxed commands and Butler's own ledger records run without a
/// card. Network and connector calls always ask; once the turn read external
/// content, a standing conversation permission no longer covers them (D5).
pub fn decide(mode: &AccessMode, request: AccessRequest) -> AccessDecision {
    use AccessDecision::{Allow, Ask, Deny};
    use CapabilityKind::{
        ButlerOutput, CommandMutation, CommandObservation, Connector, Exempt, FileEdit, FileRead,
        FolderSwitch, FullOnly, InternalRead, Network, ProjectRecord,
    };
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
    let auto = *mode == AccessMode::Auto;
    let first = auto || *mode == AccessMode::AskExceptReads;
    match request.kind {
        Exempt(_) | InternalRead | ButlerOutput => Allow,
        FileRead if first && project => Allow,
        // A folder switch within the consented folder or its repository.
        FolderSwitch | CommandObservation { sandboxed: true } if project => Allow,
        CommandObservation { sandboxed: false } | CommandMutation { .. }
            if first && project && request.risk == ApprovalRisk::Low =>
        {
            Allow
        }
        CommandMutation {
            sandbox: CommandSandbox::ProjectWrite,
        }
        | FileEdit
            if auto && project =>
        {
            Allow
        }
        ProjectRecord if auto => Allow,
        Network | Connector if request.taint == TurnTaint::External => Ask(GrantUse::Ignore),
        _ => Ask(GrantUse::Honor),
    }
}
/// Whether `decide` reads the target scope of `kind` under `mode`; callers
/// classify the filesystem only then.
pub fn needs_scope(mode: &AccessMode, kind: CapabilityKind) -> bool {
    let first = matches!(mode, AccessMode::AskExceptReads | AccessMode::Auto);
    match kind {
        CapabilityKind::FileRead | CapabilityKind::CommandMutation { .. } => first,
        CapabilityKind::CommandObservation { sandboxed } => {
            first || sandboxed && *mode == AccessMode::AskAlways
        }
        CapabilityKind::FileEdit => *mode == AccessMode::Auto,
        CapabilityKind::FolderSwitch => *mode != AccessMode::FullAccess,
        _ => false,
    }
}
impl CapabilityKind {
    /// Effects cannot inherit exemptions intended for other dispatch routes.
    pub fn gated_effect(self) -> Self {
        match self {
            Self::InternalRead | Self::Exempt(_) | Self::ButlerOutput => Self::OtherEffect,
            kind => kind,
        }
    }
    pub fn of_call(name: &str, arguments: &Map<String, Value>, ledger_effect: bool) -> Self {
        use ToolName::{
            BindSessionGitWorktree, CallMcpTool, CreateAutomation, DeleteAutomation, EditFile,
            ForgetExplicitMemory, GrepFiles, ListFiles, OutputPublish, PreviewStart, PreviewStop,
            ReadFile, RequestServiceRestart, RunCommand, RunDueAutomations, SaveWallpaperModule,
            SetWallpaper, StartTopicConversation, SwitchFolder, UpdateAutomation, WriteFile,
        };
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
                    sandboxed: butler_platform::command_sandbox::approval_free_reads(),
                },
                Some("remote_observation") => Self::Network,
                Some("mutation") => Self::CommandMutation {
                    sandbox: mutation_sandbox(arguments),
                },
                _ => Self::OtherEffect,
            },
            PreviewStart | PreviewStop => Self::CommandMutation {
                sandbox: CommandSandbox::None,
            },
            CallMcpTool => Self::Connector,
            WriteFile | EditFile => Self::FileEdit,
            CreateAutomation | UpdateAutomation | DeleteAutomation | RunDueAutomations => {
                Self::Schedule
            }
            SetWallpaper | SaveWallpaperModule => Self::SettingsWrite,
            StartTopicConversation => Self::CrossConversation,
            OutputPublish => Self::ButlerOutput,
            SwitchFolder => Self::FolderSwitch,
            _ => Self::InternalRead,
        }
    }
}
/// A mutating command can run in the project-write sandbox when this host
/// enforces one and the call did not opt out with `sandbox: "none"`.
fn mutation_sandbox(arguments: &Map<String, Value>) -> CommandSandbox {
    let requested = arguments.get("sandbox").and_then(Value::as_str);
    if butler_platform::command_sandbox::project_write_available()
        && matches!(requested, None | Some("project"))
    {
        CommandSandbox::ProjectWrite
    } else {
        CommandSandbox::None
    }
}
/// Unresolved shell evaluation must never inherit a project classification.
pub fn command_scope_unresolved(command: &str) -> bool {
    command.contains(['$', '`', '%', '!', '{', '}', '?', '*', '['])
        || butler_platform::command_sandbox::path_tokens(command)
            .iter()
            .any(|word| word.starts_with('~'))
        || command.split([';', '&', '|', '\n']).any(|segment| {
            let tokens = butler_platform::command_sandbox::path_tokens(segment);
            let mut words = tokens.iter().filter(|word| !word.starts_with('-'));
            match words.next().copied() {
                Some("cd") => words.next().is_none(),
                Some("pushd" | "popd") => true,
                _ => false,
            }
        })
}
/// Risk is shared with the exact-action approval card.
pub fn command_access_risk(command: &str) -> ApprovalRisk {
    crate::btcc::authority::approval::command_risk(command)
}
