#![allow(clippy::unwrap_used, reason = "security boundary assertions")]
use super::*;
use crate::btcc::ApprovalRisk;
use AccessDecision::*;
use AccessMode::*;
use CapabilityKind::*;
use TargetScope::*;
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
    (
        ReadOnly,
        CommandObservation { sandboxed: false },
        None,
        None,
    ),
    (ReadOnly, CommandObservation { sandboxed: true }, None, None),
    (AskAlways, InternalRead, None, None),
    (AskAlways, ButlerOutput, None, None),
    (AskExceptReads, InternalRead, None, None),
    (AskExceptReads, ButlerOutput, None, None),
    (AskExceptReads, FileRead, Some(ProjectFolder), None),
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
];
const KINDS: &[CapabilityKind] = &[
    Exempt(ApprovalExemptAction::FirstConversationOnboarding),
    Exempt(ApprovalExemptAction::MemorySave),
    Exempt(ApprovalExemptAction::AttachedImageAnalysis),
    InternalRead,
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
    FullOnly(FullOnlyAction::ServiceRestart),
    FullOnly(FullOnlyAction::GitWorktree),
    FullOnly(FullOnlyAction::MemoryForget),
    OtherEffect,
];
fn expected(mode: &AccessMode, request: AccessRequest) -> AccessDecision {
    if *mode == FullAccess {
        return Allow;
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
    for mode in AccessMode::ALL {
        for &kind in KINDS {
            for scope in [NoTarget, ProjectFolder, Outside, Protected] {
                for risk in [ApprovalRisk::Low, ApprovalRisk::Medium, ApprovalRisk::High] {
                    for taint in [TurnTaint::Clean, TurnTaint::External] {
                        let request = AccessRequest {
                            kind,
                            scope,
                            risk,
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
                        let chain = [AskAlways, AskExceptReads, FullAccess]
                            .map(|m| order(decide(&m, request)));
                        assert!(chain.windows(2).all(|pair| pair[0] <= pair[1]));
                    }
                }
            }
        }
    }
    for mode in [AskAlways, AskExceptReads] {
        let exempt: Vec<_> = ToolName::ALL
            .iter()
            .map(|t| t.as_str())
            .filter(|name| mode.exempts_tool(name))
            .collect();
        assert_eq!(
            exempt,
            [
                "analyze_attached_image",
                "ingest_task_memory",
                "summarize_user_profile",
                "update_explicit_memory",
                "update_onboarding_profile"
            ]
        );
    }
    for name in ToolName::ALL {
        assert!(!ReadOnly.exempts_tool(name.as_str()));
    }
    for (name, kind) in [
        ("call_mcp_tool", Connector),
        ("write_file", FileEdit),
        ("edit_file", FileEdit),
        ("read_file", FileRead),
        ("list_files", FileRead),
        ("grep_files", FileRead),
        ("create_automation", Schedule),
        ("update_automation", Schedule),
        ("delete_automation", Schedule),
        ("run_due_automations", Schedule),
        ("set_wallpaper", SettingsWrite),
        ("save_wallpaper_module", SettingsWrite),
        (
            "request_service_restart",
            FullOnly(FullOnlyAction::ServiceRestart),
        ),
        (
            "bind_session_git_worktree",
            FullOnly(FullOnlyAction::GitWorktree),
        ),
        (
            "forget_explicit_memory",
            FullOnly(FullOnlyAction::MemoryForget),
        ),
        ("mcp__x__y", OtherEffect),
    ] {
        assert_eq!(
            CapabilityKind::of_call(name, &serde_json::Map::new(), false),
            kind
        );
    }
    for (args, kind) in [
        (
            serde_json::json!({}),
            CommandObservation {
                sandboxed: butler_platform::command_sandbox::READ_ONLY_SANDBOX,
            },
        ),
        (
            serde_json::json!({"state_effect":"remote_observation"}),
            Network,
        ),
        (
            serde_json::json!({"state_effect":"mutation"}),
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
    ] {
        assert!(command_scope_unresolved(command));
    }
    assert!(!command_scope_unresolved("ls *.rs"));
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
