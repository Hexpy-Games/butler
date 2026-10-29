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

// A1: pin the open-time boundary after an ordinary target was classified.
pub(super) fn contained_read_rechecks_swapped_secret() {
    use crate::workspace::{PathForm, ReadFileInput, ScopeRoots, WorkspaceFiles, classify_targets};
    if !butler_platform::command_sandbox::POSIX_SHELL {
        return;
    }
    let root = std::env::temp_dir().join(format!("butler-access-a1-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "ordinary").unwrap();
    std::fs::write(root.join(".env"), "SECRET_IN_ENV").unwrap();
    let data = root.with_extension("data");
    let roots = ScopeRoots {
        attachments: &[],
        project: Some(&root),
        butler_data: &data,
        protected_ledger_roots: &[],
        installation_root: None,
    };
    assert_eq!(classify_targets(&roots, &root, &["a.txt"]), ProjectFolder);
    std::fs::remove_file(root.join("a.txt")).unwrap();
    butler_platform::secure_fs::symlink(&root.join(".env"), &root.join("a.txt")).unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let files = WorkspaceFiles::new(1);
        let result = files
            .read_one(ReadFileInput {
                butler_data: data.clone(),
                root: root.clone(),
                path: "a.txt".into(),
                path_form: PathForm::Contained,
                protected_roots: vec![],
                start_line: None,
                limit_lines: None,
                max_bytes: 2048,
                offset_bytes: None,
            })
            .await
            .unwrap()
            .unwrap()
            .result;
        files.close().await;
        assert!(
            result.to_string().contains("sensitive_path_blocked"),
            "{result}"
        );
        assert!(!result.to_string().contains("SECRET_IN_ENV"));
    });
    std::fs::remove_dir_all(root).unwrap();
}
