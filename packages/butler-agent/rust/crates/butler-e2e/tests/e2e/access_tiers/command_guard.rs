//! Approved commands retain credential denial and exact-action disclosure.
use super::*;

pub(super) async fn approved(
    s: &Scenario,
    script: &Arc<Script>,
    command: &str,
) -> Result<Value, HarnessError> {
    approved_with_timeout(s, script, command, None).await
}

pub(super) async fn approved_with_timeout(
    s: &Scenario,
    script: &Arc<Script>,
    command: &str,
    timeout_ms: Option<u64>,
) -> Result<Value, HarnessError> {
    let prompt = format!("Inspect command: {command}");
    script.rounds.lock().unwrap().insert(
        prompt.clone(),
        vec![call(
            "guard",
            "run_command",
            &json!({"command":command,
            "summary":"Inspect files", "state_effect":"read_only", "timeout_ms":timeout_ms.unwrap_or(30_000),
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
    let body = value
        .get("output")
        .filter(|v| v.is_object())
        .unwrap_or(&value);
    let refusal = matches!(
        body["error"].as_str(),
        Some("protected_path" | "command_path_unknown")
    );
    let diagnostic = body["stderr"]
        .as_str()
        .is_some_and(|reason| !reason.is_empty());
    if refusal || body["ok"] == false && diagnostic {
        assert_eq!(body["command"], command);
        assert!(
            body["stderr"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty())
        );
        assert!(!body.to_string().contains("credential-fixture"));
        let rows = tool_rows(&s.gw.messages("general").await?, &id);
        assert_eq!(rows.len(), 1);
        let visible = s.gw.operation_output(&id, &rows[0]).await?;
        let shown: Value = serde_json::from_str(&visible)?;
        let shown = shown
            .get("output")
            .filter(|v| v.is_object())
            .unwrap_or(&shown);
        assert_eq!(shown["command"], command);
        assert_eq!(shown["stderr"], body["stderr"]);
        assert!(!visible.contains("credential-fixture"));
    }
    Ok(body.clone())
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
            format!("cd \"$BUTLER_DATA\" && (cd /tmp) && cat {relative}"),
            format!("{{ cd \"$BUTLER_DATA\"; }} && cat {relative}"),
            format!("if cd \"$BUTLER_DATA\"; then cat {relative}; fi"),
            format!("command cd \"$BUTLER_DATA\"; cat {relative}"),
            format!("builtin cd \"$BUTLER_DATA\"; cat {relative}"),
            format!("cat \"$BUTLER_DATA/{relative}$NOPE\""),
            format!("cat \"${{BUTLER_DATA:-x}}/{relative}\""),
            format!("cat \"$BUTLER_DATA\"/{relative}"),
            format!("cat \"$BUTLER_DATA\"\"/{relative}\""),
            format!("cat $BUTLER_DATA/{}*/{leaf}", &folder[..folder.len() - 1]),
        ] {
            let result = approved(&s, &script, &command).await?;
            let denied = credential_denied(&result);
            eprintln!("lexical_guard denied={denied}: {command}");
            if !denied {
                missing.push(command);
            }
        }
    }
    for command in ["cat ~/.ssh/*", "cat \"$HOME\"/.ssh/*"] {
        let result = approved(&s, &script, command).await?;
        let denied = credential_denied(&result);
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
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
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
            let denied = if butler_platform::command_sandbox::approval_free_reads() {
                result["exit_code"] != 0 && result["stdout"] == "boundary-probe"
            } else {
                result["error"] == "command_path_unknown" && result["stdout"] == ""
            };
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
    let repo = setup.sandbox.workspace.join("x");
    let initialized = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&repo)
        .output()?;
    assert!(initialized.status.success());
    let s = setup.start().await?;
    let status = approved(&s, &script, "git -C x status").await?;
    assert_eq!(status["exit_code"], 0, "{status}");
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

#[tokio::test]
async fn approved_command_guard_allows_name_patterns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL
            && butler_platform::command_sandbox::approval_free_reads(),
        "POSIX read sandbox"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-NAME-PATTERNS")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    std::fs::write(setup.sandbox.workspace.join("ordinary.txt"), "ordinary")?;
    let s = setup.start().await?;
    let mut failures = Vec::new();
    for (command, exit) in [
        ("find . -name '*.pem'", 0),
        ("grep -r BEGIN --include='*.key' .", 1),
    ] {
        let result = approved(&s, &script, command).await?;
        if result["error"] == "protected_path"
            || result["exit_code"] != exit
            || result["stdout"] != ""
            || result["stderr"] != ""
        {
            failures.push(format!("{command}: {result}"));
        }
        assert!(
            !result["stdout"]
                .as_str()
                .unwrap_or_default()
                .contains("credential-fixture")
        );
    }
    s.finish().await?;
    server.abort();
    assert!(failures.is_empty(), "name patterns refused: {failures:?}");
    Ok(())
}

fn credential_denied(result: &Value) -> bool {
    // A sandbox may hide glob matches or deny the read; directory builtins
    // may print first. Require a failed read and no credential content.
    !result["stdout"]
        .as_str()
        .unwrap_or_default()
        .contains("credential-fixture")
        && (result["error"] == "protected_path"
            || result["exit_code"].as_i64().is_some_and(|code| code != 0))
}
