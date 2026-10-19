//! Secret aliases must remain contained during and after command execution.
use super::*;

fn environment(s: &Setup) -> HashMap<String, String> {
    HashMap::from([
        ("HOME".into(), s.sandbox.home.display().to_string()),
        ("BUTLER_DATA".into(), s.sandbox.data.display().to_string()),
        ("BUTLER_OPENAI_AUTH_PROFILE".into(), "profiles/login".into()),
    ])
}

fn writable(s: &Setup, command: &str) -> Invocation {
    let secrets = command_sandbox::discover_project_secrets(&s.sandbox.workspace).unwrap();
    let mut denied: Vec<_> = secrets.iter().map(PathBuf::as_path).collect();
    denied.push(&s.sandbox.data);
    command_sandbox::project_write_shell(
        command,
        &environment(s),
        &s.sandbox.workspace,
        &[],
        &denied,
        None,
    )
    .unwrap()
}

#[tokio::test]
async fn sweep_quarantines_secret_target_links() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret links");
    let mut s = Setup::new("LINUX-SECRET-LINK-SWEEP")?;
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("src"))?;
    for dir in ["auth", "profiles/login"] {
        std::fs::create_dir_all(s.sandbox.data.join(dir))?;
        std::fs::write(s.sandbox.data.join(dir).join("entry"), "private-fixture")?;
    }
    std::fs::write(root.join(".env"), "private-fixture")?;
    std::fs::write(root.join("public"), "complete-public")?;
    butler_platform::secure_fs::symlink(&root.join("public"), &root.join("src/changed"))?;
    let outside = s.sandbox.home.join("ordinary");
    std::fs::write(&outside, "private-fixture")?;
    let since = command_sandbox::discover_project_secrets(root)?;
    let command = format!(
        "set -e; ln -s '{}' src/credential; ln -s '{}' src/profile; ln -s ../.env src/project; ln -s '{}' src/directory; rm src/changed; ln -s ../.env src/changed; ln -s ../public src/safe; ln -s '{}' src/.env-alias; ln -s '{}' src/indirect",
        s.sandbox.data.join("auth/entry").display(),
        s.sandbox.data.join("profiles/login/entry").display(),
        s.sandbox.data.join("auth").display(),
        outside.display(),
        outside.display(),
    );
    let output = run(writable(&s, &command), root, &s.sandbox.home);
    assert!(output.status.success(), "link creation must complete");
    let moved = command_sandbox::sweep_new_secrets_with_environment(
        root,
        &since,
        &s.sandbox.data,
        &environment(&s),
    )?;
    let expected: Vec<_> = [
        ".env-alias",
        "changed",
        "credential",
        "directory",
        "indirect",
        "profile",
        "project",
    ]
    .map(|name| root.join("src").join(name))
    .into();
    assert_eq!(moved, expected);
    for path in &moved {
        assert!(std::fs::symlink_metadata(path).is_err());
    }
    let quarantine = std::fs::read_dir(s.sandbox.data.join("sandbox-quarantine"))?
        .next()
        .unwrap()?
        .path();
    for path in expected {
        assert!(
            std::fs::symlink_metadata(quarantine.join(path.strip_prefix(root).unwrap()))?
                .file_type()
                .is_symlink()
        );
    }
    assert_eq!(
        std::fs::read_to_string(root.join("src/safe"))?,
        "complete-public"
    );
    assert_eq!(
        std::fs::read_to_string(root.join(".env"))?,
        "private-fixture"
    );
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn secret_named_link_denies_external_target() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret links");
    let mut s = Setup::new("LINUX-SECRET-LINK-EXTERNAL")?;
    let target = s.sandbox.home.join("ordinary");
    std::fs::write(&target, "private-fixture")?;
    butler_platform::secure_fs::symlink(&target, &s.sandbox.workspace.join(".env"))?;
    for path in [&target, &s.sandbox.workspace.join(".env")] {
        let invocation = command_sandbox::login_shell_contained(
            &format!("cat '{}'", path.display()),
            &environment(&s),
            &[],
            &[&s.sandbox.workspace],
        )
        .unwrap();
        let output = run(invocation, &s.sandbox.workspace, &s.sandbox.home);
        assert!(
            !output.status.success(),
            "secret alias target must be denied"
        );
        assert!(output.stdout.is_empty(), "secret alias contents escaped");
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn credential_links_deny_reads_and_writes_during_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret links");
    let mut s = Setup::new("LINUX-SECRET-LINK-IO")?;
    let root = &s.sandbox.workspace;
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::create_dir_all(s.sandbox.data.join("auth"))?;
    let target = s.sandbox.data.join("auth/credentials.json");
    std::fs::write(&target, "private-fixture")?;
    butler_platform::secure_fs::symlink(&target, &root.join("src/existing"))?;
    for created in [false, true] {
        for write in [false, true] {
            let name = if created { "src/new" } else { "src/existing" };
            let prefix = if created {
                format!("rm -f {name}; ln -s '{}' {name}; ", target.display())
            } else {
                String::new()
            };
            let action = if write {
                format!("printf changed > {name}")
            } else {
                format!("cat {name}")
            };
            let output = run(
                writable(&s, &format!("{prefix}{action}")),
                root,
                &s.sandbox.home,
            );
            assert!(!output.status.success(), "created={created} write={write}");
            assert!(output.stdout.is_empty(), "credential contents escaped");
            assert_eq!(std::fs::read_to_string(&target)?, "private-fixture");
        }
    }
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn unresolved_secret_named_link_refuses_launch() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret links");
    let mut s = Setup::new("LINUX-SECRET-LINK-UNRESOLVED")?;
    butler_platform::secure_fs::symlink(
        &s.sandbox.home.join("missing"),
        &s.sandbox.workspace.join(".env"),
    )?;
    let invocation = command_sandbox::login_shell_contained(
        "printf ran",
        &environment(&s),
        &[],
        &[&s.sandbox.workspace],
    )
    .unwrap();
    let output = run(invocation, &s.sandbox.workspace, &s.sandbox.home);
    assert!(
        !output.status.success(),
        "unresolved secret target must refuse launch"
    );
    assert!(output.stdout.is_empty(), "command must not execute");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("secret symlink target cannot be resolved safely")
    );
    s.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn guided_sweep_uses_command_auth_profile_inventory() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux secret links");
    use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};
    let mut s = Setup::new("LINUX-SECRET-LINK-GUIDED")?;
    let root = &s.sandbox.workspace;
    let profile = s.sandbox.data.join("profiles/login");
    std::fs::create_dir_all(&profile)?;
    std::fs::create_dir_all(root.join("src"))?;
    std::fs::write(profile.join("entry"), "private-fixture")?;
    let owner = Commands::new();
    let mut host_environment = environment(&s);
    host_environment.insert("PATH".into(), std::env::var("PATH").unwrap());
    let result = owner
        .submit_guided(GuidedCommandInput {
            command: format!("ln -s '{}' src/alias", profile.join("entry").display()),
            cwd: None,
            workspace_root: root.clone(),
            butler_data: s.sandbox.data.clone(),
            timeout_ms: Some(10_000.0),
            access: GuidedAccess::ProjectWrite,
            host_environment,
            abort: tokio_util::sync::CancellationToken::new(),
        })
        .unwrap()
        .await
        .unwrap();
    owner.close().await;
    let output = result.unwrap();
    std::fs::remove_file(output.payload_source.path)?;
    assert_eq!(output.summary.exit_code, Some(0));
    assert_eq!(
        output.summary.sandbox_violation,
        vec![root.join("src/alias")]
    );
    assert!(std::fs::symlink_metadata(root.join("src/alias")).is_err());
    assert_eq!(
        std::fs::read_to_string(profile.join("entry"))?,
        "private-fixture"
    );
    s.sandbox.mark_success();
    Ok(())
}
