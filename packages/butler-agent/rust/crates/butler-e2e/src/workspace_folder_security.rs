// test-category: security
//! Direct resolver boundary checks live in the dev-only harness, keeping the
//! gateway non-E2E ratchet unchanged. No host service or model is started.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_gateway::gateway::project_folder::resolve_workspace_folder as resolve;
use butler_platform::secure_fs;
use std::fs;

// test-category: security
#[test]
fn workspace_folder_resolver_contains_paths_and_links() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("folder-security-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("workspace/outer/inner"))?;
    fs::create_dir(root.join("outside"))?;
    let outcome = (|| -> Result<(), Box<dyn std::error::Error>> {
        let workspace = root.join("workspace");
        for path in [
            "..",
            "a/../..",
            "/etc",
            r"C:\",
            "C:",
            r"\\server\share",
            "//server/share",
            "a//b",
            "a/",
            "/",
            ".",
            "a/./b",
            r"a\b",
            "a:b",
            "a\0b",
            "a\nb",
        ] {
            let error = resolve(&workspace, path).expect_err("invalid path accepted");
            assert!(
                matches!(error, butler_gateway::gateway::GatewayApplicationError::Public { status: 400, ref code, .. }
                if code == "project_folder_path_invalid"),
                "{path:?}: {error:?}"
            );
        }
        secure_fs::fixture_links::directory_alias(
            &root.join("outside"),
            &workspace.join("outside-link"),
        )?;
        let error = resolve(&workspace, "outside-link").expect_err("escape accepted");
        assert!(
            matches!(error, butler_gateway::gateway::GatewayApplicationError::Public { status: 403, ref code, .. }
            if code == "project_folder_outside_workspace")
        );
        secure_fs::fixture_links::directory_alias(
            &workspace.join("outer"),
            &workspace.join("inside-link"),
        )?;
        let nested = secure_fs::canonicalize(workspace.join("outer/inner"))?;
        assert_eq!(
            resolve(&workspace, "inside-link/inner")?,
            Some(nested.clone())
        );
        assert_eq!(resolve(&workspace, "outer/inner")?, Some(nested));
        assert!(resolve(&root.join("missing"), "")?.is_none());
        assert!(!root.join("missing").exists());
        Ok(())
    })();
    fs::remove_dir_all(root)?;
    outcome
}
