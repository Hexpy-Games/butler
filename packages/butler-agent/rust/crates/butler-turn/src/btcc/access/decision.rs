use super::{AccessMode, ApprovalExemptAction};
use crate::btcc::ApprovalRisk;
use butler_core::tool_protocol::ToolName;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityKind {
    Exempt(ApprovalExemptAction),
    InternalRead,
    WebRequest {
        carries_data: bool,
    },
    FileRead,
    CommandObservation {
        sandboxed: bool,
    },
    CommandMutation {
        sandbox: CommandSandbox,
    },
    ImageModelCall,
    Network,
    Connector,
    FileEdit,
    Schedule,
    SettingsWrite,
    ProjectRecord,
    /// Durable lifecycle bookkeeping that also bootstraps its own Plan authority.
    WorkRecord,
    CrossConversation,
    ButlerOutput,
    DeliverFiles,
    FullOnly(FullOnlyAction),
    /// Moving the session's working folder; its scope says whether the
    /// target stays within the consented folder or its repository.
    FolderSwitch,
    OtherEffect,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandSandbox {
    /// The user disabled containment, or its preference could not be read.
    Disabled,
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
    /// The turn was admitted from an untrusted connector event.
    ConnectorEvent,
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
        ButlerOutput, CommandMutation, CommandObservation, Connector, DeliverFiles, Exempt,
        FileEdit, FileRead, FolderSwitch, FullOnly, InternalRead, Network, ProjectRecord,
        WorkRecord,
    };
    if request.taint == TurnTaint::ConnectorEvent
        && (request.kind.can_send_outside() || request.kind.persists_beyond_turn())
    {
        return if *mode == AccessMode::ReadOnly {
            Deny(DenyReason::ReadOnly)
        } else {
            Ask(GrantUse::Ignore)
        };
    }
    if *mode == AccessMode::FullAccess {
        return Allow;
    }
    if let CapabilityKind::WebRequest { carries_data } = request.kind {
        return if request.taint == TurnTaint::Clean || !carries_data {
            Allow
        } else if *mode == AccessMode::ReadOnly {
            Deny(DenyReason::ReadOnly)
        } else {
            Ask(GrantUse::Ignore)
        };
    }
    if matches!(request.kind, FullOnly(_)) {
        return Deny(DenyReason::FullAccessRequired);
    }
    if *mode == AccessMode::ReadOnly {
        return if matches!(
            request.kind,
            InternalRead | WorkRecord | FileRead | DeliverFiles | CommandObservation { .. }
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
        Exempt(_) | InternalRead | WorkRecord | ButlerOutput | DeliverFiles => Allow,
        CommandMutation {
            sandbox: CommandSandbox::Disabled,
        } if auto => Ask(GrantUse::Honor),
        FileRead if first && (project || request.scope == TargetScope::Attachment) => Allow,
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
        CapabilityKind::ImageModelCall | ProjectRecord if auto => Allow,
        CapabilityKind::ImageModelCall => Ask(GrantUse::Ignore),
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
    /// Gate creation rather than propagating taint through every derived artifact
    /// forever (schedule runs, recalled memory, new conversations). That propagation
    /// is fragile; a card lets the user see the exact artifact before it exists.
    /// Documents are inert data read on demand, never instructions; Library
    /// organization lets briefs attach them. Connector classification rules are
    /// host-constrained and announced once with undo, so they also need no card.
    pub fn persists_beyond_turn(self) -> bool {
        match self {
            Self::Exempt(action) => match action {
                ApprovalExemptAction::FirstConversationOnboarding
                | ApprovalExemptAction::MemorySave => true,
                ApprovalExemptAction::AttachedImageAnalysis
                | ApprovalExemptAction::LibraryOrganize
                | ApprovalExemptAction::DocumentWrite => false,
            },
            Self::FileEdit
            | Self::Schedule
            | Self::SettingsWrite
            | Self::ProjectRecord
            | Self::WorkRecord
            | Self::CrossConversation
            | Self::ButlerOutput
            | Self::FolderSwitch
            | Self::FullOnly(FullOnlyAction::GitWorktree | FullOnlyAction::MemoryForget) => true,
            Self::InternalRead
            | Self::FileRead
            | Self::WebRequest { .. }
            | Self::CommandObservation { .. }
            | Self::CommandMutation { .. }
            | Self::ImageModelCall
            | Self::Network
            | Self::Connector
            | Self::DeliverFiles
            | Self::FullOnly(FullOnlyAction::ServiceRestart)
            | Self::OtherEffect => false,
        }
    }

    /// Commands and undeclared effects can send data too; containment does
    /// not establish that a command has no outward effect. Butler's own
    /// records, outputs and delivery to its user remain internal operations.
    fn can_send_outside(self) -> bool {
        matches!(
            self,
            Self::Exempt(ApprovalExemptAction::AttachedImageAnalysis)
                | Self::Connector
                | Self::Network
                | Self::ImageModelCall
                | Self::WebRequest { carries_data: true }
                | Self::CommandMutation { .. }
                | Self::CommandObservation { .. }
                | Self::OtherEffect
        )
    }

    /// Effects cannot inherit exemptions intended for other dispatch routes.
    pub fn gated_effect(self) -> Self {
        match self {
            Self::InternalRead
            | Self::WorkRecord
            | Self::Exempt(_)
            | Self::ButlerOutput
            | Self::DeliverFiles => Self::OtherEffect,
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
            ToolName::WebRead => Self::WebRequest {
                carries_data: super::web_read_carries_data(
                    arguments.get("url").and_then(Value::as_str).unwrap_or(""),
                    false,
                ),
            },
            ToolName::WebSearch => Self::WebRequest {
                carries_data: super::web_search_carries_data(
                    arguments.get("query").and_then(Value::as_str).unwrap_or(""),
                ),
            },
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
            ToolName::GenerateImage | ToolName::EditImage => Self::ImageModelCall,
            CallMcpTool => Self::Connector,
            WriteFile | EditFile => Self::FileEdit,
            CreateAutomation | UpdateAutomation | DeleteAutomation | RunDueAutomations => {
                Self::Schedule
            }
            SetWallpaper | SaveWallpaperModule => Self::SettingsWrite,
            StartTopicConversation => Self::CrossConversation,
            ToolName::ControlWork
                if arguments.get("action").and_then(Value::as_str) == Some("view_result") =>
            {
                Self::InternalRead
            }
            ToolName::CanonPropose | ToolName::ControlWork => Self::ProjectRecord,
            ToolName::StartWork
            | ToolName::ContinueWork
            | ToolName::ReplaceWorkPlan
            | ToolName::RecordWorkCheckpoint
            | ToolName::RecordWorkReview
            | ToolName::RecordWorkDisposition => Self::WorkRecord,
            OutputPublish => Self::ButlerOutput,
            ToolName::DeliverFiles => Self::DeliverFiles,
            SwitchFolder => Self::FolderSwitch,
            // Includes classification rules, whose host enforces action and read-only limits.
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
    let command = butler_platform::command_sandbox::path_script(command);
    command.contains(['$', '`', '%', '!', '{', '}', '?', '*', '['])
        || unresolved_words(command, true)
}

/// Track shell words without interpreting them. Adjacent quoted pieces cannot
/// be screened separately, and a cwd change invalidates relative candidates
/// even when that change is conditional, fails, or runs in a pipeline.
fn unresolved_words(command: &str, check_escapes: bool) -> bool {
    let mut word = String::new();
    let mut quote = None;
    let mut closed_quote = false;
    let mut program = true;
    for (offset, ch) in command.char_indices() {
        if check_escapes
            && ch == butler_platform::command_sandbox::SHELL_ESCAPE
            && !matches!(quote, Some(('\'', _)))
        {
            return true;
        }
        if let Some((open, start)) = quote {
            if ch == open {
                if unresolved_words(&command[start..offset], check_escapes && open != '\'') {
                    return true;
                }
                quote = None;
                closed_quote = true;
            } else {
                word.push(ch);
            }
        } else if ch.is_whitespace() || [';', '&', '|', '(', ')', '<', '>'].contains(&ch) {
            if unresolved_word(&word, &mut program) {
                return true;
            }
            word.clear();
            closed_quote = false;
            if [';', '&', '|', '(', ')', '\n'].contains(&ch) {
                program = true;
            }
        } else if ['"', '\''].contains(&ch) {
            if (!word.is_empty() && !word.ends_with('=')) || closed_quote {
                return true;
            }
            quote = Some((ch, offset + ch.len_utf8()));
        } else {
            if closed_quote {
                return true;
            }
            word.push(ch);
        }
    }
    quote.is_some() || unresolved_word(&word, &mut program)
}

fn unresolved_word(word: &str, program: &mut bool) -> bool {
    if word.starts_with('~') || word.split(['/', '\\']).any(|part| part == "..") {
        return true;
    }
    if word.is_empty() || !*program {
        return false;
    }
    let name = word.to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "cd" | "chdir"
            | "pushd"
            | "popd"
            | "set-location"
            | "sl"
            | "push-location"
            | "pop-location"
            | "cd.."
    ) || name.starts_with("cd\\")
        || name.starts_with("cd/")
    {
        return true;
    }
    // Grammar prefixes and transparent builtin dispatch leave the next word
    // in program position; their presence alone does not make scope unknown.
    *program = matches!(
        name.as_str(),
        "if" | "then"
            | "elif"
            | "else"
            | "while"
            | "until"
            | "do"
            | "command"
            | "builtin"
            | "eval"
            | "time"
            | "exec"
            | "coproc"
            | "noglob"
            | "nocorrect"
            | "call"
    ) || word.starts_with('-')
        || word.split_once('=').is_some_and(|(key, _)| {
            !key.is_empty()
                && key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        });
    false
}
/// Risk is shared with the exact-action approval card.
pub fn command_access_risk(command: &str) -> ApprovalRisk {
    crate::btcc::authority::approval::command_risk(command)
}
