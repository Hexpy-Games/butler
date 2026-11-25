use super::*;

#[test]
fn allowed_folder_writes_and_carveouts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-ALLOWED-FOLDERS")?;
    let extra = f.setup.sandbox.home.join("work");
    let outside = f.setup.sandbox.home.join("outside");
    std::fs::create_dir_all(extra.join(".git"))?;
    std::fs::create_dir(&outside)?;
    let env_file = extra.join(".env");
    let git_config = extra.join(".git/config");
    for path in [&env_file, &git_config] {
        std::fs::write(path, "protected-marker")?;
    }
    setup_complete!(f);
    assert!(command_sandbox::folder_write_available());
    let workspace = f.root.clone();
    let f = Fixture { root: extra, ..f };
    let mut secrets = command_sandbox::discover_project_secrets(&f.root)?;
    secrets.extend(command_sandbox::discover_project_secrets(&workspace)?);
    let denied: Vec<_> = secrets.iter().map(PathBuf::as_path).collect();
    let scratch: Vec<_> = f.scratch.iter().map(PathBuf::as_path).collect();
    let toolchain = toolchain_roots();
    let outside_file = outside.join("x");
    for (path, succeeds) in [
        ("'new.txt'".to_owned(), true),
        ("'.env'".to_owned(), false),
        ("'.git/config'".to_owned(), false),
        (quote(&outside_file), false),
    ] {
        let script = format!("$ErrorActionPreference='Stop'; [IO.File]::WriteAllText({path},'x')");
        let invocation = command_sandbox::project_write_shell(
            &script,
            &f.env,
            &f.root,
            &[&workspace],
            &scratch,
            &denied,
            toolchain.as_ref(),
        )
        .unwrap();
        let output = f.launch(&invocation);
        assert_eq!(output.status.success(), succeeds, "{script}: {output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            ![
                "command_observation_isolation_unavailable",
                "PowerShell language policy blocks this operation",
                "ConstrainedLanguage",
                command_sandbox::EXECUTION_FAILURE_MARKER,
                command_sandbox::EXECUTION_TIMEOUT_MARKER,
            ]
            .iter()
            .any(|marker| stderr.contains(marker)),
            "helper failure or timeout does not prove a boundary: {output:?}"
        );
    }
    assert!(f.root.join("new.txt").is_file());
    assert_eq!(std::fs::read_to_string(env_file)?, "protected-marker");
    assert_eq!(std::fs::read_to_string(git_config)?, "protected-marker");
    assert!(!outside_file.exists());
    f.finish();
    Ok(())
}
