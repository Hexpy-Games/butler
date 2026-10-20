//! The actual approval fallback runs on hosts without kernel read containment.
use super::*;

#[tokio::test]
async fn command_guard_without_read_sandbox() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::approval_free_reads(),
        "Host without read sandbox"
    );
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
        let result = command_guard::approved(&s, &script, command).await?;
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
