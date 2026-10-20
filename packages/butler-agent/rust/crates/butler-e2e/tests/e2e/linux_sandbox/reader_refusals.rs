//! Contained read_file refusals retain the public guard contract.
use super::*;
use butler_platform::secure_fs;
use butler_runtime::capabilities::{Capabilities, CapabilityInvocation};
use butler_turn::workspace::{WorkspaceFiles, WorkspaceMutations};
use std::sync::Arc;

#[tokio::test]
async fn contained_read_file_refusals_preserve_guard_fields_and_safe_explanations()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("CONTAINED-READ-REFUSALS")?;
    let root = &setup.sandbox.workspace;
    let outside = &setup.sandbox.home;
    let files = Arc::new(WorkspaceFiles::new(2));
    let capabilities = Capabilities::new(Arc::clone(&files), Arc::new(WorkspaceMutations::new()));
    std::fs::write(root.join(".env"), "private-fixture")?;
    std::fs::write(outside.join("outside.txt"), "outside")?;
    let protected = root.join("ledger");
    std::fs::create_dir_all(&protected).unwrap();
    std::fs::write(protected.join("record"), b"ledger").unwrap();
    std::fs::create_dir(root.join("folder")).unwrap();
    let mut cases = vec![
        (
            "../outside.txt",
            "path_escape",
            "The requested path is outside the permitted scope.",
        ),
        (
            ".env",
            "sensitive_path_blocked",
            "The requested path contains sensitive or credential files.",
        ),
        (
            "ledger/record",
            "protected_path",
            "Project Ledger paths require dedicated tools.",
        ),
        ("folder", "not_a_file", "The requested path is a directory."),
        (
            "missing.txt",
            "not_found",
            "The requested path was not found.",
        ),
    ];
    if secure_fs::NO_FOLLOW {
        secure_fs::symlink(&outside.join("outside.txt"), &root.join("link")).unwrap();
        cases.push((
            "link",
            "symlink_escape",
            "The requested path is outside the permitted scope.",
        ));
    }
    for (path, code, message) in cases {
        let call = json!({"arguments":{"requests":[{"path":path}]}});
        let result = capabilities
            .invoke(
                "read_file",
                CapabilityInvocation {
                    contained: true,
                    call: &call,
                    workspace_reference: None,
                    workspace_path: Some(root),
                    butler_data: &setup.sandbox.data,
                    protected_ledger_roots: std::slice::from_ref(&protected),
                    allowed_tools_and_effects: None,
                    mutation_scope: None,
                    installation_root: None,
                },
            )
            .await
            .unwrap();
        let file = &result["files"][0];
        assert_eq!(file["error"], code, "{result}");
        assert_eq!(file["message"], message, "{result}");
        assert_eq!(file["workspace_root"], json!(root), "{result}");
        assert_eq!(file["guard"]["workspace_root"], json!(root));
        assert_eq!(file["guard"]["ok"], false);
        assert_ne!(file["recovery_hint"].as_str().unwrap(), "");
        for field in ["message", "recovery_hint"] {
            let text = file[field].as_str().unwrap();
            assert!(!text.contains(".env") && !text.contains(outside.to_str().unwrap()));
        }
        let guard_message = file["guard"]["message"].as_str().unwrap();
        assert!(!guard_message.contains(".env"));
        assert!(!guard_message.contains(outside.to_str().unwrap()));
    }
    files.close().await;
    setup.sandbox.mark_success();
    Ok(())
}
