use super::*;
use std::process::Command;

#[cfg(unix)]
#[tokio::test]
async fn batch_directory_alias_groups_one_target_like_source() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join("real")).unwrap();
    fixture.write("real/target.txt", b"first");
    symlink(fixture.root.join("real"), fixture.root.join("alias")).unwrap();
    let expected_sha256 = sha(b"first");
    let call = json!({"arguments":{"edits":[
        {"path":"real/target.txt","old_text":"first","new_text":"second","expected_sha256":expected_sha256},
        {"path":"alias/target.txt","old_text":"second","new_text":"third","expected_sha256":expected_sha256}
    ]}});
    let actual = rust(&fixture, "edit_file", &call, None, None).await;
    assert_eq!(actual["ok"], true);
    assert_eq!(
        std::fs::read(fixture.root.join("real/target.txt")).unwrap(),
        b"third"
    );
    let correct = sha(b"third");
    let rejected = json!({"arguments":{"edits":[
        {"path":"real/target.txt","old_text":"third","new_text":"fourth","expected_sha256":correct},
        {"path":"alias/target.txt","old_text":"fourth","new_text":"fifth","expected_sha256":"0".repeat(64)}
    ]}});
    let actual = rust(&fixture, "edit_file", &rejected, None, None).await;
    assert_eq!(actual["ok"], false);
    assert!(actual["error"].is_string());
    assert_eq!(
        std::fs::read(fixture.root.join("real/target.txt")).unwrap(),
        b"third"
    );
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn explicit_installation_root_rejects_mutation() {
    let fixture = Fixture::new();
    let call = json!({"arguments":{"path":"program.txt","content":"no"}});
    let actual = fixture
        .capabilities
        .invoke(
            "write_file",
            CapabilityInvocation {
                call: &call,
                workspace_reference: None,
                workspace_path: Some(&fixture.root),
                butler_data: &fixture.root,
                protected_ledger_roots: &[],
                allowed_tools_and_effects: None,
                mutation_scope: None,
                installation_root: Some(&fixture.root),
            },
        )
        .await
        .unwrap();
    assert_eq!(actual["error"], "program_directory_read_only");
    assert!(!fixture.root.join("program.txt").exists());
    fixture.capabilities.mutations.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn canonical_installation_alias_is_read_only() {
    let fixture = Fixture::new();
    let installation = fixture.root.join("installation");
    let workspace = fixture.root.join("workspace");
    std::fs::create_dir_all(&installation).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(installation.join("resource.txt"), "immutable").unwrap();
    std::os::unix::fs::symlink(&installation, workspace.join("alias")).unwrap();
    let call =
        json!({"arguments":{"path":"alias/resource.txt","content":"changed","overwrite":true}});
    let result = fixture
        .capabilities
        .invoke(
            "write_file",
            CapabilityInvocation {
                call: &call,
                workspace_reference: None,
                workspace_path: Some(&workspace),
                butler_data: &fixture.root,
                protected_ledger_roots: &[],
                allowed_tools_and_effects: None,
                mutation_scope: None,
                installation_root: Some(&installation),
            },
        )
        .await
        .unwrap();
    assert_eq!(result["error"], "program_directory_read_only");
    assert_eq!(
        std::fs::read_to_string(installation.join("resource.txt")).unwrap(),
        "immutable"
    );
    fixture.capabilities.mutations.close().await;
}

#[test]
fn environment_home_is_not_installation_authority() {
    const CHILD: &str = "BUTLER_K1B_HOME_TEST_CHILD";
    const ROOT: &str = "BUTLER_K1B_HOME_TEST_ROOT";
    if std::env::var_os(CHILD).is_some() {
        let root = std::path::PathBuf::from(std::env::var_os(ROOT).unwrap());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let owner = Arc::new(WorkspaceMutations::new());
            let capabilities = crate::capabilities::NativeCapabilities::new(
                Arc::new(crate::workspace::NativeWorkspaceFiles::new(1)),
                Arc::clone(&owner),
            );
            let call = json!({"arguments":{"path":"environment.txt","content":"no"}});
            let result = capabilities
                .invoke(
                    "write_file",
                    CapabilityInvocation {
                        call: &call,
                        workspace_reference: None,
                        workspace_path: Some(&root),
                        butler_data: &root,
                        protected_ledger_roots: &[],
                        allowed_tools_and_effects: None,
                        mutation_scope: None,
                        installation_root: None,
                    },
                )
                .await
                .unwrap();
            assert_eq!(result["ok"], true);
            assert!(root.join("environment.txt").exists());
            owner.close().await;
        });
        return;
    }
    let fixture = Fixture::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("capabilities::tests::mutations::guard_tests::environment_home_is_not_installation_authority")
        .env(CHILD, "1")
        .env(ROOT, &fixture.root)
        .env("BUTLER_HOME", &fixture.root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn protected_ledger_and_sensitive_paths_are_not_mutated() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root.join(".project-ledger")).unwrap();
    for (name, call) in [
        (
            "write_file",
            json!({"arguments":{"path":".project-ledger/source.txt","content":"no"}}),
        ),
        (
            "edit_file",
            json!({"arguments":{"path":".project-ledger/source.txt",
            "old_text":"old","new_text":"new"}}),
        ),
        (
            "write_file",
            json!({"arguments":{"path":".env.local","content":"no"}}),
        ),
    ] {
        let actual = rust(&fixture, name, &call, None, None).await;
        assert_eq!(actual["ok"], false, "{name}: {call}");
        assert!(actual["error"].is_string(), "{name}: {call}");
    }
    assert!(!fixture.root.join(".project-ledger/source.txt").exists());
    assert!(!fixture.root.join(".env.local").exists());
    fixture.capabilities.mutations.close().await;
}

#[tokio::test]
async fn number_coercion_selects_hinted_occurrence() {
    for hint in [json!("0x2"), json!([2]), json!("2e0")] {
        let fixture = Fixture::new();
        fixture.write("repeat.txt", b"x\nx\n");
        let call = json!({"arguments":{"path":"repeat.txt","old_text":"x",
            "new_text":"y","start_line":hint}});
        let actual = rust(&fixture, "edit_file", &call, None, None).await;
        assert_eq!(actual["ok"], true, "hint {hint}");
        assert_eq!(
            std::fs::read(fixture.root.join("repeat.txt")).unwrap(),
            b"x\ny\n"
        );
        fixture.capabilities.mutations.close().await;
    }
}
