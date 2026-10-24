use super::*;

pub(super) fn boundaries() {
    for mode in [AskAlways, AskExceptReads, Auto] {
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
                "update_onboarding_profile",
                "library_organize",
                "document_create",
                "document_edit"
            ]
        );
    }
    for name in ToolName::ALL {
        assert!(!ReadOnly.exempts_tool(name.as_str()));
    }
    for (name, kind) in [
        ("call_mcp_tool", Connector),
        ("deliver_files", DeliverFiles),
        ("output_publish", ButlerOutput),
        (
            "document_create",
            Exempt(ApprovalExemptAction::DocumentWrite),
        ),
        ("document_edit", Exempt(ApprovalExemptAction::DocumentWrite)),
        ("document_read", InternalRead),
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
        ("library_search", InternalRead),
        (
            "library_organize",
            Exempt(ApprovalExemptAction::LibraryOrganize),
        ),
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
        ("switch_folder", FolderSwitch),
        ("mcp__x__y", OtherEffect),
    ] {
        assert_eq!(
            CapabilityKind::of_call(name, &serde_json::Map::new(), false),
            kind
        );
    }
}
