//! Approved commands retain credential denial and exact-action disclosure.
use super::*;

async fn approved(
    s: &Scenario,
    script: &Arc<Script>,
    command: &str,
) -> Result<Value, HarnessError> {
    let prompt = format!("Inspect command: {command}");
    script.rounds.lock().unwrap().insert(
        prompt.clone(),
        vec![call(
            "guard",
            "run_command",
            &json!({"command":command,
            "summary":"Inspect files", "state_effect":"read_only",
            "cwd":s.sandbox.workspace.to_string_lossy()}),
        )],
    );
    let id = paused(s, "general", &prompt).await?;
    let cards = s.gw.approval_requests("general").await?;
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["approval"]["examples"], json!([command]));
    approve(s, "general", "allow").await?;
    delivered(s, "general", &id).await?;
    let results = outputs(s, "general", &id, script, &prompt).await?;
    assert_eq!(results.len(), 1);
    let value: Value = serde_json::from_str(&results[0])?;
    Ok(value
        .get("output")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(value))
}

#[tokio::test]
async fn approved_command_guard_normalizes_shell_paths() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX shell forms"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-GUARD")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    for relative in ["auth/probe.txt", "state/app-gateway/probe.txt"] {
        let path = setup.sandbox.data.join(relative);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, "credential-fixture")?;
    }
    let ssh = setup.sandbox.home.join(".ssh");
    std::fs::create_dir_all(&ssh)?;
    std::fs::write(ssh.join("probe.txt"), "credential-fixture")?;
    let s = setup.start().await?;
    let mut missing = Vec::new();
    for relative in ["auth/probe.txt", "state/app-gateway/probe.txt"] {
        let (folder, leaf) = relative.rsplit_once('/').unwrap();
        for command in [
            format!("cd \"$BUTLER_DATA\" && cat {relative}"),
            format!("pushd \"$BUTLER_DATA\"; cat {relative}"),
            format!("cat \"$BUTLER_DATA\"/{relative}"),
            format!("cat \"$BUTLER_DATA\"\"/{relative}\""),
            format!("cat $BUTLER_DATA/{}*/{leaf}", &folder[..folder.len() - 1]),
        ] {
            let result = approved(&s, &script, &command).await?;
            let denied = result["error"] == "protected_path";
            eprintln!("lexical_guard denied={denied}: {command}");
            if !denied {
                missing.push(command);
            }
        }
    }
    for command in ["cat ~/.ssh/*", "cat \"$HOME\"/.ssh/*"] {
        let result = approved(&s, &script, command).await?;
        let denied = result["error"] == "protected_path";
        eprintln!("lexical_guard denied={denied}: {command}");
        if !denied {
            missing.push(command.to_owned());
        }
    }
    s.finish().await?;
    server.abort();
    assert!(missing.is_empty(), "lexical guard missed: {missing:?}");
    Ok(())
}

#[tokio::test]
async fn approved_command_guard_opaque_programs_hit_kernel_boundary() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL
            && butler_platform::command_sandbox::approval_free_reads(),
        "Enforced POSIX sandbox"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-OPAQUE")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    for relative in ["auth/probe.txt", "state/app-gateway/probe.txt"] {
        let path = setup.sandbox.data.join(relative);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, "credential-fixture")?;
    }
    let s = setup.start().await?;
    let mut missing = Vec::new();
    for relative in ["auth/probe.txt", "state/app-gateway/probe.txt"] {
        for command in [
            format!("printf boundary-probe; p=\"$BUTLER_DATA\"; cat \"$p/{relative}\""),
            format!("printf boundary-probe; cat \"$(printf %s \"$BUTLER_DATA\")/{relative}\""),
            format!("printf boundary-probe; sh -c 'cat \"$BUTLER_DATA\"/{relative}'"),
            format!("printf boundary-probe; p=\"$BUTLER_DATA\"; eval 'cat \"$p/{relative}\"'"),
            format!(
                "printf boundary-probe; cd \"$(printf %s \"$BUTLER_DATA\")\" && cat {relative}"
            ),
        ] {
            let result = approved(&s, &script, &command).await?;
            let denied = result["exit_code"] != 0 && result["stdout"] == "boundary-probe";
            eprintln!("kernel_boundary denied={denied}: {command}");
            if !denied {
                missing.push(command);
            }
        }
    }
    s.finish().await?;
    server.abort();
    assert!(missing.is_empty(), "kernel boundary missed: {missing:?}");
    Ok(())
}

#[tokio::test]
async fn approved_command_guard_allows_ordinary_paths() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-ORDINARY")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    std::fs::create_dir_all(setup.sandbox.workspace.join("src"))?;
    std::fs::write(
        setup.sandbox.workspace.join("src/main.rs"),
        "complete-source",
    )?;
    std::fs::write(setup.sandbox.workspace.join("main.rs"), "ordinary")?;
    std::fs::create_dir_all(setup.sandbox.home.join("project"))?;
    std::fs::write(
        setup.sandbox.home.join("project/file"),
        "complete-home-file",
    )?;
    let s = setup.start().await?;
    for (command, expected) in [
        ("cd src && cat main.rs", "complete-source"),
        ("ls *.rs", "main.rs\n"),
        ("cat \"$HOME/project/file\"", "complete-home-file"),
    ] {
        let result = approved(&s, &script, command).await?;
        assert_eq!(result["exit_code"], 0, "{command}");
        assert_eq!(result["stdout"], expected, "{command}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
