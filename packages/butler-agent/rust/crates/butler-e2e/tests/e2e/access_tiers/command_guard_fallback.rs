//! Registered non-Full-Access commands require the lexical fallback on every host.
use super::*;

#[tokio::test]
async fn command_guard_without_read_sandbox() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-FALLBACK")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    for relative in ["auth/probe.txt", "app/runtime/auth/probe.txt"] {
        let credential = setup.sandbox.data.join(relative);
        std::fs::create_dir_all(credential.parent().unwrap())?;
        std::fs::write(credential, "token credential-fixture")?;
    }
    let s = setup.start().await?;
    disable_sandbox(&s).await?;
    let mut missing = Vec::new();
    let commands: &[&str] = if butler_platform::command_sandbox::POSIX_SHELL {
        &[
            "cat \"$BUTLER_DATA/auth/probe.txt$NOPE\"",
            "cat \"${BUTLER_DATA:-x}/auth/probe.txt\"",
            "cd \"$BUTLER_DATA\"; :=; cat auth/probe.txt",
            "cd \"$BUTLER_DATA\"; cd /; cd -; cat auth/probe.txt",
            "cd \"$BUTLER_DATA\" && (cd /tmp) && cat auth/probe.txt",
            "{ cd \"$BUTLER_DATA\"; } && cat auth/probe.txt",
            "if cd \"$BUTLER_DATA\"; then cat auth/probe.txt; fi",
            "command cd \"$BUTLER_DATA\"; cat auth/probe.txt",
            "builtin cd \"$BUTLER_DATA\"; cat auth/probe.txt",
            "grep -r token \"$BUTLER_DATA\"/ap*",
            "grep -r token \"$BUTLER_DATA\"",
            "p=\"$BUTLER_DATA\"; sh -c 'cat \"$BUTLER_DATA/auth/probe.txt\"'",
        ]
    } else {
        &[
            "Push-Location $env:BUTLER_DATA; gc app/runtime/auth/local-admin.json",
            "pushd $env:BUTLER_DATA; Push-Location /; Pop-Location; gc auth/probe.txt",
            "Get-Content \"$env:BUTLER_DATA/auth/probe.txt$unknown\"",
            "Get-ChildItem -Recurse $env:BUTLER_DATA",
            "Get-ChildItem -Recurse $env:BUTLER_DATA/ap*",
        ]
    };
    for command in commands {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        let refused = matches!(
            result["error"].as_str(),
            Some("protected_path" | "command_path_unknown")
        );
        if !refused {
            missing.push(command);
        }
    }
    s.finish().await?;
    server.abort();
    assert!(missing.is_empty(), "fallback missed: {missing:?}");
    Ok(())
}

#[tokio::test]
async fn command_guard_volume_case() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(butler_platform::command_sandbox::POSIX_SHELL, "POSIX paths");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-VOLUME-CASE")?
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let root = setup.sandbox.data.join("auth");
    std::fs::create_dir_all(&root)?;
    std::fs::write(root.join("probe.txt"), "credential-fixture")?;
    std::fs::write(
        setup.sandbox.workspace.join("ordinary.txt"),
        "ordinary-source",
    )?;
    let insensitive = setup.sandbox.data.join("AUTH/probe.txt").exists();
    eprintln!("credential volume case_insensitive={insensitive}");
    let s = setup.start().await?;
    let mut failures = Vec::new();
    for (command, protected) in [
        ("cat \"$BUTLER_DATA/AUTH/probe.txt\"", true),
        ("cat \"$BUTLER_DATA\"/AUT*/probe.txt", true),
        ("p=ordinary.txt; cat \"$p\"", false),
    ] {
        let prompt = format!("Check volume case: {command}");
        script.rounds.lock().unwrap().insert(
            prompt.clone(),
            vec![call(
                "case",
                "run_command",
                &json!({"command":command,"summary":"Inspect files","state_effect":"read_only",
                "cwd":s.sandbox.workspace.to_string_lossy()}),
            )],
        );
        let reply = s.gw.say("general", &prompt).await?;
        let id = accepted_turn_id(&reply)?;
        delivered(&s, "general", &id).await?;
        let results = outputs(&s, "general", &id, &script, &prompt).await?;
        if !protected {
            assert!(
                results
                    .iter()
                    .any(|result| result.contains("ordinary-source")),
                "{results:?}"
            );
        }
        if protected
            && insensitive
            && !results
                .iter()
                .any(|result| result.contains("protected_path"))
        {
            failures.push(command);
        }
    }
    s.finish().await?;
    server.abort();
    assert!(failures.is_empty(), "case aliases missed: {failures:?}");
    Ok(())
}

async fn disable_sandbox(s: &Scenario) -> Result<(), HarnessError> {
    let reply =
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], false);
    Ok(())
}

#[tokio::test]
async fn command_guard_sandbox_off_approved_reads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    verify_sandbox_off(Access::AskAlways).await
}

#[tokio::test]
async fn command_guard_sandbox_off_full_access_best_effort() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    verify_sandbox_off(Access::FullAccess).await
}

const OFF_READS: [&str; 6] = [
    "cat \"$BUTLER_DATA/auth/probe.txt$NOPE\"",
    "cat \"${BUTLER_DATA:-x}/auth/probe.txt\"",
    "cd \"$BUTLER_DATA\"; cd /; cd -; cat auth/probe.txt",
    "cd \"$BUTLER_DATA\" && (cd /tmp) && cat auth/probe.txt",
    "grep -r token \"$BUTLER_DATA\"/ap*",
    "grep -r token \"$BUTLER_DATA\"",
];

async fn verify_sandbox_off(access: Access) -> Result<(), HarnessError> {
    let full = matches!(access, Access::FullAccess);
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("COMMAND-SANDBOX-OFF")?
        .access(access)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    for relative in ["auth/probe.txt", "app/runtime/auth/probe.txt"] {
        let path = setup.sandbox.data.join(relative);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, "token credential-fixture")?;
    }
    std::fs::create_dir_all(setup.sandbox.workspace.join("src"))?;
    std::fs::write(
        setup.sandbox.workspace.join("src/main.rs"),
        "complete-source",
    )?;
    std::fs::write(setup.sandbox.workspace.join("main.rs"), "ordinary")?;
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(setup.sandbox.workspace.join("x"))
        .output()?;
    assert!(init.status.success());
    let s = setup.start().await?;
    disable_sandbox(&s).await?;
    // Read the data root before prior commands create output artifacts that
    // would themselves become recursive grep input.
    for (index, command) in OFF_READS.iter().enumerate().rev() {
        let result = if full {
            unrestricted(&s, &script, command).await?
        } else {
            command_guard::approved_with_timeout(&s, &script, command, Some(1000)).await?
        };
        eprintln!(
            "sandbox_off full={full} case={index} error={} exit={}",
            result["error"], result["exit_code"]
        );
        assert_off_read(&result, full, index);
    }
    for (command, expected) in [
        ("cd src && cat main.rs", Some("complete-source")),
        ("ls *.rs", Some("main.rs\n")),
        ("git -C x status", None),
    ] {
        let result = if full {
            unrestricted(&s, &script, command).await?
        } else {
            command_guard::approved_with_timeout(&s, &script, command, Some(1000)).await?
        };
        assert_eq!(result["exit_code"], 0, "{command}");
        if let Some(expected) = expected {
            assert_eq!(result["stdout"], expected);
        }
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_off_read(result: &Value, full: bool, index: usize) {
    if full {
        // Full Access has no kernel read boundary. Incomplete words and
        // ancestors are best-effort, and these reads reach the toy credentials.
        assert_ne!(result["error"], "command_path_unknown");
        assert_ne!(result["error"], "protected_path");
        assert_eq!(result["exit_code"], 0);
        assert_eq!(result["timed_out"], false);
        if index < 5 {
            assert!(
                result["stdout"]
                    .as_str()
                    .is_some_and(|s| s.contains("credential-fixture"))
            );
        }
    } else {
        assert_eq!(result["command"], OFF_READS[index]);
        assert!(
            result["stderr"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty())
        );
        assert!(!result.to_string().contains("credential-fixture"));
        if butler_platform::command_sandbox::approval_free_reads() {
            assert!(result["error"].is_null());
            assert_eq!(result["exit_code"], if index < 4 { 1 } else { 2 });
            assert_eq!(result["timed_out"], false);
        } else {
            assert_eq!(
                result["error"],
                if index < 4 {
                    "command_path_unknown"
                } else {
                    "protected_path"
                }
            );
        }
    }
}

async fn unrestricted(
    s: &Scenario,
    script: &Arc<Script>,
    command: &str,
) -> Result<Value, HarnessError> {
    let prompt = format!("Full access inspection: {command}");
    script.rounds.lock().unwrap().insert(
        prompt.clone(),
        vec![call(
            "full",
            "run_command",
            &json!({"command":command,"summary":"Inspect files","state_effect":"read_only","timeout_ms":1000,
        "cwd":s.sandbox.workspace.to_string_lossy()}),
        )],
    );
    let reply = s.gw.say("general", &prompt).await?;
    let id = accepted_turn_id(&reply)?;
    delivered(s, "general", &id).await?;
    assert_eq!(s.gw.approval_requests("general").await?.len(), 0);
    let results = outputs(s, "general", &id, script, &prompt).await?;
    assert_eq!(results.len(), 1);
    let value: Value = serde_json::from_str(&results[0])?;
    Ok(value
        .get("output")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(value))
}
