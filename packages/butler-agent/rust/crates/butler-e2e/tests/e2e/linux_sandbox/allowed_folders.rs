use super::*;

#[test]
fn allowed_folder_writes_and_carveouts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux project sandbox");
    butler_e2e::skip_unless!(
        command_sandbox::folder_write_available(),
        "Linux mount tier"
    );
    let mut setup = Setup::new("LINUX-ALLOWED-FOLDERS")?;
    let root = &setup.sandbox.workspace;
    let home = &setup.sandbox.home;
    let extra = home.join("work");
    let outside = home.join("outside");
    let scratch = setup.sandbox.data.join("tmp/project-write");
    for directory in [&extra.join(".git"), &outside, &scratch] {
        std::fs::create_dir_all(directory)?;
    }
    let env_file = extra.join(".env");
    let git_config = extra.join(".git/config");
    for path in [&env_file, &git_config] {
        std::fs::write(path, "protected-marker")?;
    }
    let mut secrets = command_sandbox::discover_project_secrets(root)?;
    secrets.extend(command_sandbox::discover_project_secrets(&extra)?);
    let mut denied: Vec<_> = secrets.iter().map(PathBuf::as_path).collect();
    denied.push(&setup.sandbox.data);
    let environment = HashMap::from([("HOME".into(), home.display().to_string())]);
    let new_file = extra.join("new.txt");
    let outside_file = outside.join("x");
    for (command, succeeds) in [
        (format!("touch '{}'", new_file.display()), true),
        (
            format!(r#"sh -c 'echo x > "$1"' sh '{}'"#, env_file.display()),
            false,
        ),
        (
            format!(r#"sh -c 'echo x > "$1"' sh '{}'"#, git_config.display()),
            false,
        ),
        (format!("touch '{}'", outside_file.display()), false),
    ] {
        let invocation = command_sandbox::project_write_shell(
            &command,
            &environment,
            root,
            &[&extra],
            &[&scratch],
            &denied,
            None,
        )
        .unwrap();
        let output = run(invocation, root, home);
        assert_eq!(output.status.success(), succeeds, "{command}: {output:?}");
    }
    assert!(new_file.is_file());
    assert_eq!(std::fs::read_to_string(env_file)?, "protected-marker");
    assert_eq!(std::fs::read_to_string(git_config)?, "protected-marker");
    assert!(!outside_file.exists());
    setup.sandbox.mark_success();
    Ok(())
}
