#![allow(clippy::unwrap_used, reason = "security boundary assertions")]
mod classification;
mod web;
use super::*;
use crate::btcc::ApprovalRisk;
use AccessDecision::{Allow, Ask, Deny};
use AccessMode::{AskAlways, AskExceptReads, Auto, FullAccess, ReadOnly};
use CapabilityKind::{
    ButlerOutput, CommandMutation, CommandObservation, Connector, CrossConversation, DeliverFiles,
    Exempt, FileEdit, FileRead, FolderSwitch, FullOnly, InternalRead, Network, OtherEffect,
    ProjectRecord, Schedule, SettingsWrite, WebRequest,
};
use TargetScope::{Attachment, NoTarget, Outside, ProjectFolder, Protected};
use butler_core::tool_protocol::ToolName;

// Independent owner cells; None is a wildcard, not an implementation branch.
const ALLOW: &[(
    AccessMode,
    CapabilityKind,
    Option<TargetScope>,
    Option<ApprovalRisk>,
)] = &[
    (ReadOnly, InternalRead, None, None),
    (ReadOnly, FileRead, None, None),
    (ReadOnly, DeliverFiles, None, None),
    (
        ReadOnly,
        CommandObservation { sandboxed: false },
        None,
        None,
    ),
    (ReadOnly, CommandObservation { sandboxed: true }, None, None),
    (AskAlways, InternalRead, None, None),
    (AskAlways, ButlerOutput, None, None),
    (AskAlways, DeliverFiles, None, None),
    (AskExceptReads, InternalRead, None, None),
    (AskExceptReads, ButlerOutput, None, None),
    (AskExceptReads, DeliverFiles, None, None),
    (AskExceptReads, FileRead, Some(ProjectFolder), None),
    (AskExceptReads, FileRead, Some(Attachment), None),
    (
        AskAlways,
        CommandObservation { sandboxed: true },
        Some(ProjectFolder),
        None,
    ),
    (
        AskExceptReads,
        CommandObservation { sandboxed: true },
        Some(ProjectFolder),
        None,
    ),
    (
        AskExceptReads,
        CommandObservation { sandboxed: false },
        Some(ProjectFolder),
        Some(ApprovalRisk::Low),
    ),
    (
        AskExceptReads,
        CommandMutation {
            sandbox: CommandSandbox::None,
        },
        Some(ProjectFolder),
        Some(ApprovalRisk::Low),
    ),
    (
        AskExceptReads,
        CommandMutation {
            sandbox: CommandSandbox::ProjectWrite,
        },
        Some(ProjectFolder),
        Some(ApprovalRisk::Low),
    ),
    // A folder switch within the consented folder or its repository.
    (AskAlways, FolderSwitch, Some(ProjectFolder), None),
    (AskExceptReads, FolderSwitch, Some(ProjectFolder), None),
    (Auto, FolderSwitch, Some(ProjectFolder), None),
    // Auto (알아서 진행): Ask first plus project edits, project-sandboxed
    // commands and Butler's own ledger records.
    (Auto, InternalRead, None, None),
    (Auto, ButlerOutput, None, None),
    (Auto, DeliverFiles, None, None),
    (Auto, FileRead, Some(ProjectFolder), None),
    (Auto, FileRead, Some(Attachment), None),
    (
        Auto,
        CommandObservation { sandboxed: true },
        Some(ProjectFolder),
        None,
    ),
    (
        Auto,
        CommandObservation { sandboxed: false },
        Some(ProjectFolder),
        Some(ApprovalRisk::Low),
    ),
    (
        Auto,
        CommandMutation {
            sandbox: CommandSandbox::None,
        },
        Some(ProjectFolder),
        Some(ApprovalRisk::Low),
    ),
    (
        Auto,
        CommandMutation {
            sandbox: CommandSandbox::ProjectWrite,
        },
        Some(ProjectFolder),
        None,
    ),
    (Auto, FileEdit, Some(ProjectFolder), None),
    (Auto, ProjectRecord, None, None),
];
const KINDS: &[CapabilityKind] = &[
    Exempt(ApprovalExemptAction::FirstConversationOnboarding),
    Exempt(ApprovalExemptAction::MemorySave),
    Exempt(ApprovalExemptAction::AttachedImageAnalysis),
    Exempt(ApprovalExemptAction::LibraryOrganize),
    Exempt(ApprovalExemptAction::DocumentWrite),
    InternalRead,
    WebRequest {
        carries_data: false,
    },
    WebRequest { carries_data: true },
    FileRead,
    CommandObservation { sandboxed: true },
    CommandObservation { sandboxed: false },
    CommandMutation {
        sandbox: CommandSandbox::None,
    },
    CommandMutation {
        sandbox: CommandSandbox::ProjectWrite,
    },
    Network,
    Connector,
    FileEdit,
    Schedule,
    SettingsWrite,
    ProjectRecord,
    CrossConversation,
    ButlerOutput,
    DeliverFiles,
    FullOnly(FullOnlyAction::ServiceRestart),
    FullOnly(FullOnlyAction::GitWorktree),
    FullOnly(FullOnlyAction::MemoryForget),
    FolderSwitch,
    OtherEffect,
];
fn expected(mode: &AccessMode, request: AccessRequest) -> AccessDecision {
    if *mode == FullAccess {
        return Allow;
    }
    if let WebRequest { carries_data } = request.kind {
        return match (mode, request.taint, carries_data) {
            (_, TurnTaint::Clean, _) | (_, _, false) => Allow,
            (ReadOnly, _, true) => Deny(DenyReason::ReadOnly),
            _ => Ask(GrantUse::Ignore),
        };
    }
    if [
        FullOnly(FullOnlyAction::ServiceRestart),
        FullOnly(FullOnlyAction::GitWorktree),
        FullOnly(FullOnlyAction::MemoryForget),
    ]
    .contains(&request.kind)
    {
        return Deny(DenyReason::FullAccessRequired);
    }
    if *mode != ReadOnly && matches!(request.kind, Exempt(_)) {
        return Allow;
    }
    if ALLOW.iter().any(|(m, k, s, r)| {
        m == mode
            && *k == request.kind
            && s.is_none_or(|s| s == request.scope)
            && r.is_none_or(|r| r == request.risk)
    }) {
        return Allow;
    }
    if *mode == ReadOnly {
        Deny(DenyReason::ReadOnly)
    } else if matches!(request.kind, Network | Connector) && request.taint == TurnTaint::External {
        // D5: after external content, standing permissions no longer apply.
        Ask(GrantUse::Ignore)
    } else {
        Ask(GrantUse::Honor)
    }
}
fn order(decision: AccessDecision) -> u8 {
    match decision {
        Deny(_) => 0,
        Ask(GrantUse::Ignore) => 1,
        Ask(GrantUse::Honor) => 2,
        Allow => 3,
    }
}
// test-category: security
#[test]
fn access_boundary_matches_the_owner_table() {
    classification::contained_read_rechecks_swapped_secret();
    web::boundaries();
    assert_eq!(
        AccessMode::ALL.map(|mode| mode.as_str()),
        butler_core::tool_protocol::ACCESS_MODE_WIRE_NAMES,
    );
    for mode in AccessMode::ALL {
        for &kind in KINDS {
            for scope in [NoTarget, ProjectFolder, Attachment, Outside, Protected] {
                for risk in [ApprovalRisk::Low, ApprovalRisk::Medium, ApprovalRisk::High] {
                    for taint in [TurnTaint::Clean, TurnTaint::External] {
                        let request = AccessRequest {
                            kind,
                            risk,
                            scope,
                            taint,
                        };
                        assert_eq!(
                            decide(&mode, request),
                            expected(&mode, request),
                            "{mode:?} {request:?}"
                        );
                        if !needs_scope(&mode, kind) {
                            assert_eq!(
                                decide(&mode, request),
                                decide(
                                    &mode,
                                    AccessRequest {
                                        scope: NoTarget,
                                        ..request
                                    }
                                )
                            );
                        }
                        let chain = [AskAlways, AskExceptReads, Auto, FullAccess]
                            .map(|m| order(decide(&m, request)));
                        assert!(chain.windows(2).all(|pair| pair[0] <= pair[1]));
                    }
                }
            }
        }
    }
    classification::boundaries();
    for (args, kind) in [
        (
            serde_json::json!({}),
            CommandObservation {
                sandboxed: butler_platform::command_sandbox::approval_free_reads(),
            },
        ),
        (
            serde_json::json!({"state_effect":"remote_observation"}),
            Network,
        ),
        (
            serde_json::json!({"state_effect":"mutation"}),
            CommandMutation {
                sandbox: if butler_platform::command_sandbox::project_write_available() {
                    CommandSandbox::ProjectWrite
                } else {
                    CommandSandbox::None
                },
            },
        ),
        (
            serde_json::json!({"state_effect":"mutation","sandbox":"none"}),
            CommandMutation {
                sandbox: CommandSandbox::None,
            },
        ),
    ] {
        assert_eq!(
            CapabilityKind::of_call("run_command", args.as_object().unwrap(), false),
            kind
        );
    }
    for command in [
        "cat $HOME/x",
        "ls ~",
        "ls %USERPROFILE%",
        "ls !USERPROFILE!",
        "cat `pwd`",
        "ls /tmp/*",
        "cat {..,a}/outside.txt",
        "cd && cat .zsh_history",
        "cd -- && cat .zsh_history",
        "cd '' && cat .zsh_history",
        "pushd",
        "popd",
        "cat .en?",
        "cat [.]env",
        "ls *.rs",
        "cd /var && cat file",
        "chdir /var",
        "(cd /var && cat file)",
        "if true; then command cd /var; fi",
        "builtin cd /var",
        "command -p cd /var",
        "A=b cd /var",
        "cd /var | true; cat file",
        "cd /absent; cat file",
        "pushd /var",
        "Set-Location C:\\Users",
        "sl C:/Users",
        "Push-Location C:/Users",
        "Pop-Location",
        "CD..",
        "cd\\",
        "cd/",
        "cat \"/var\"/file",
        "cat \"/var\"\"/file\"",
        "cat /v'a'r/file",
        "cat a/../b",
        "cat ..",
        "cat C:\\a\\..\\b",
        "cat \"a b/../c\"",
        "cat --opt=\"/var\"/auth/x",
        "cat --opt=\"a\"\"b\"",
        "cat \"a\"\"b\"",
        "bash -c \"cd /var && cat auth/probe.txt\"",
        "sh -c 'cd /var && cat auth/probe.txt'",
        "eval \"cd /var; cat auth/probe.txt\"",
        "cmd /c \"cd /var && cat auth/probe.txt\"",
        "pwsh -Command \"Set-Location /var\"",
        "iex \"cd /var; cat auth/probe.txt\"",
        "echo 'cd /var'",
        "echo 'cat a/../b'",
        "bash -c \"sh -c 'cd /var'\"",
        "eval cd /var",
        "time cd /var",
        "exec cd /var",
        "coproc cd /var",
        "noglob cd /var",
        "nocorrect cd /var",
        "call cd /var",
    ] {
        assert!(command_scope_unresolved(command), "{command}");
    }
    for command in [
        "cat notes.txt",
        "ls",
        "git status",
        "echo hi > out.txt",
        "cat 'ordinary file'",
        "cat \"ordinary file\"",
        "echo cd /var",
        "if true; then cat ordinary; fi",
        "command cat ordinary",
        "cat a/.../b",
        r"cat 'a\b'",
        "cat --opt=\"ordinary file\"",
        "KEY=\"ordinary value\" cat notes.txt",
        "cat --opt='ordinary file'",
        "KEY='ordinary value' cat notes.txt",
    ] {
        assert!(!command_scope_unresolved(command), "{command}");
    }
    if butler_platform::command_sandbox::POSIX_SHELL {
        for command in [r"cat /d/au\th/x", r"cat My\ Dir/x"] {
            assert!(command_scope_unresolved(command), "{command}");
        }
    }
    if !butler_platform::command_sandbox::POSIX_SHELL {
        for command in [
            "cmd /c cd",
            "cmd /c cd C:/Users",
            "powershell -Command \"pushd C:/Users\"",
            "powershell.exe -Command \"ls ~\"",
        ] {
            assert!(command_scope_unresolved(command), "{command}");
        }
    }
    for name in [
        "run_command",
        "write_file",
        "edit_file",
        "bind_session_git_worktree",
        "start_topic_conversation",
        "request_service_restart",
        "canon_propose",
        "create_automation",
        "update_automation",
        "delete_automation",
        "run_due_automations",
    ] {
        let kind = CapabilityKind::of_call(name, &serde_json::Map::new(), false);
        assert!(
            !matches!(kind, InternalRead | Exempt(_) | ButlerOutput),
            "{name}"
        );
    }
    for name in [
        "project_ledger_create",
        "project_ledger_update",
        "project_ledger_work_update",
        "project_ledger_task_update",
        "project_ledger_task_complete",
        "project_ledger_attempt_succeed",
        "project_ledger_attempt_fail",
    ] {
        assert_eq!(
            CapabilityKind::of_call(name, &serde_json::Map::new(), true),
            ProjectRecord
        );
    }
    for kind in [
        InternalRead,
        ButlerOutput,
        DeliverFiles,
        Exempt(ApprovalExemptAction::MemorySave),
    ] {
        assert_eq!(kind.gated_effect(), OtherEffect);
    }
    assert!(!needs_scope(
        &AskAlways,
        CommandObservation { sandboxed: false }
    ));
    for spelling in [
        r"C:foo",
        r"C:\p\a.txt:s",
        r"C:\p\a.txt::$DATA",
        r"\\.\C:\p",
        r"\\?\GLOBALROOT\x",
        r"C:\p\a.",
        r"C:\p\a ",
        r"C:\p\NUL.txt",
        r"C:\p\PROGRA~1",
    ] {
        assert!(
            butler_platform::secure_fs::windows_ambiguous_spelling(spelling),
            "{spelling}"
        );
    }
    for spelling in [
        r"C:\p\a.txt",
        r"\\?\C:\p\a.txt",
        r"\\server\share\a",
        "/p/a.txt",
        r"C:\p\.hidden",
    ] {
        assert!(
            !butler_platform::secure_fs::windows_ambiguous_spelling(spelling),
            "{spelling}"
        );
    }
    // D7: the derived schedule default never widens a read-only choice and
    // never narrows full access; every asking default becomes Auto.
    for (conversation, schedule) in [
        (ReadOnly, ReadOnly),
        (AskAlways, Auto),
        (AskExceptReads, Auto),
        (Auto, Auto),
        (FullAccess, FullAccess),
    ] {
        assert_eq!(AccessMode::schedule_default_for(&conversation), schedule);
    }
    for mode in AccessMode::ALL {
        assert_eq!(AccessMode::parse(mode.as_str()), Some(mode.clone()));
        assert_eq!(
            serde_json::from_value::<AccessMode>(serde_json::json!(mode.as_str())).unwrap(),
            mode
        );
        for other in AccessMode::ALL {
            assert!(mode.clone().narrower(other.clone()).rank() <= other.rank());
        }
    }
}
