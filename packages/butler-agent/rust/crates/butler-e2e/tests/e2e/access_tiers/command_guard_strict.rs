//! Strict screening with approved commands and no kernel read sandbox.
use super::*;

#[tokio::test]
async fn strict_script_state_regressions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("STRICT-SCRIPT-STATE")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("PATH", command_guard_followup::common_tool_path());
    setup.sandbox.workspace = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(setup.sandbox.workspace.join("src"))?;
    std::fs::create_dir_all(setup.sandbox.home.join(".aws"))?;
    std::fs::write(
        setup.sandbox.home.join(".aws/credentials"),
        "private-marker",
    )?;
    std::fs::write(setup.sandbox.workspace.join("x"), "ordinary")?;
    let s = setup.start().await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?
            .status,
        200
    );
    let mut failures = Vec::new();
    for command in [
        "ln -s ../../.aws src/k; cat src/k/credentials",
        "shopt -s dotglob; cat ~/*/credentials",
        "shopt -s extglob; cat ~/*/credentials",
        "setopt GLOB_DOTS; cat ~/*/credentials",
        "unsetopt GLOB_DOTS; cat ~/*/credentials",
        "set -o noglob; cat ~/*/credentials",
        "set +o noglob; cat ~/*/credentials",
        "GLOBIGNORE=; cat ~/*/credentials",
        "IFS=/; cat ~/*/credentials",
        "alias cat=echo; cat ~/*/credentials",
        "enable -n echo; cat ~/*/credentials",
        "source x; cat ~/*/credentials",
        ". x; cat ~/*/credentials",
        "f() { echo ordinary; }; cat ~/*/credentials",
        "tar xf archive.tar; cat unpacked/credentials",
        "git checkout branch; cat checkout/credentials",
    ] {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        if result["error"] != "command_path_unknown"
            || result.to_string().contains("private-marker")
        {
            failures.push(format!("{command}: {result}"));
        }
    }
    for command in [
        "mkdir -p build/out && cp x build/out/",
        "touch fresh; printf ordinary > written",
        "echo ordinary; cat absent/file",
        "ls x; printf ordinary > final",
    ] {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        if !result["error"].is_null() {
            failures.push(format!("ordinary {command}: {result}"));
        }
    }
    s.finish().await?;
    server.abort();
    assert!(failures.is_empty(), "strict regressions: {failures:#?}");
    Ok(())
}

#[tokio::test]
async fn strict_foreign_attached_cd_regressions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_platform::command_sandbox::{PathSyntax, screen_paths_with};
    let mut setup = Setup::new("STRICT-ATTACHED-CD")?;
    let cwd = std::fs::canonicalize(&setup.sandbox.workspace)?;
    let env = std::collections::HashMap::new();
    let mut failures = Vec::new();
    for syntax in [PathSyntax::PowerShell, PathSyntax::Cmd] {
        for word in [
            "cd..",
            "Cd\\",
            "CD/",
            "ChDiR..",
            "chdir/",
            "cd../other",
            "chdir.foo",
        ] {
            let command = format!("{word}; Get-Content .butler/auth/probe.txt");
            let screen = screen_paths_with(&command, &cwd, &env, syntax);
            if screen.complete
                && screen.candidates.last().unwrap().path
                    == Some(cwd.join(".butler/auth/probe.txt"))
            {
                failures.push(format!("{syntax:?}: {command}: {screen:?}"));
            }
        }
    }
    setup.sandbox.mark_success();
    assert!(
        failures.is_empty(),
        "attached cd regressions: {failures:#?}"
    );
    Ok(())
}

#[tokio::test]
async fn strict_native_attached_cd_regressions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows shells"
    );
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("STRICT-NATIVE-CD")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    setup.sandbox.workspace = setup.sandbox.home.join("proj");
    setup.sandbox.data = setup.sandbox.home.join(".butler");
    std::fs::create_dir_all(&setup.sandbox.workspace)?;
    let s = setup.start().await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?
            .status,
        200
    );
    let root = s.sandbox.data.ancestors().last().unwrap();
    let rooted = s.sandbox.data.strip_prefix(root).unwrap().to_string_lossy();
    let commands = [
        "cd..; Get-Content .butler/auth/probe.txt".to_owned(),
        "ChDiR..; Get-Content .butler/auth/probe.txt".to_owned(),
        format!(r#"cd\; Get-Content "{rooted}/auth/probe.txt""#),
        format!(r#"cd/; Get-Content "{rooted}/auth/probe.txt""#),
        r#"cmd /c "cd.. & type .butler/auth/probe.txt""#.to_owned(),
        r#"cmd /c "chdir.. & type .butler/auth/probe.txt""#.to_owned(),
        format!(r#"cmd /c "cd\ & type {rooted}/auth/probe.txt""#),
        format!(r#"cmd /c "cd/ & type {rooted}/auth/probe.txt""#),
    ];
    for command in commands {
        let result =
            command_guard::approved_effect(&s, &script, &command, None, "mutation").await?;
        assert!(
            matches!(
                result["error"].as_str(),
                Some("command_path_unknown" | "protected_path")
            ),
            "{command}: {result}"
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
