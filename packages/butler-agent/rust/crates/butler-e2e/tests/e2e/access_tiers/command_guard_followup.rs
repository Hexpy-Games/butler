//! Registered non-Full-Access runs have no kernel credential-read boundary.
use super::*;

#[tokio::test]
async fn registered_guard_followup_regressions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("COMMAND-FOLLOWUP")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("PATH", common_tool_path());
    setup.sandbox.workspace = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&setup.sandbox.workspace)?;
    let home = &setup.sandbox.home;
    std::fs::create_dir_all(home.join("Documents"))?;
    std::fs::create_dir_all(home.join(".aws"))?;
    std::fs::create_dir_all(home.join(".config"))?;
    std::fs::write(home.join(".aws/credentials"), "toy-private-marker")?;
    std::fs::create_dir_all(setup.sandbox.workspace.join("src"))?;
    butler_platform::secure_fs::symlink(
        &home.join("Documents"),
        &setup.sandbox.workspace.join("d"),
    )?;
    std::fs::write(
        setup.sandbox.workspace.join("Cargo.toml"),
        "[package]\nname='ordinary'\nversion='0.1.0'\nedition='2021'\n",
    )?;
    std::fs::write(setup.sandbox.workspace.join("src/main.rs"), "fn main() {}")?;
    std::fs::write(
        setup.sandbox.workspace.join("package.json"),
        r#"{"scripts":{"build":"printf ordinary"}}"#,
    )?;
    std::fs::write(
        setup.sandbox.workspace.join("src/Makefile"),
        "all:\n\t@printf ordinary\n",
    )?;
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["add", "."],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&setup.sandbox.workspace)
                .status()?
                .success()
        );
    }
    let s = setup.start().await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?
            .status,
        200
    );
    let mut failures = Vec::new();
    for (command, error, word) in [
        ("cat d/../.aws/credentials", "protected_path", ""),
        ("cd d; cat ../.aws/credentials", "protected_path", ""),
        (
            "cat missing/../ordinary",
            "command_path_unknown",
            "missing/../ordinary",
        ),
        (
            "ln -s ~/Documents fresh; cat fresh/../.aws/credentials",
            "command_path_unknown",
            "fresh/../.aws/credentials",
        ),
        (
            "cd / | true; cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        (
            "cd /nonexistent; cat ../.aws/credentials",
            "command_path_unknown",
            "/nonexistent",
        ),
        (
            "cd / || cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        (
            "cd / & cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        (
            "cd d/../.aws/credentials; cat ordinary",
            "command_path_unknown",
            "d/../.aws/credentials",
        ),
        (
            "false && cd / && true; cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        ("tar czf out.tgz ~", "protected_path", ""),
        ("ls ~/.*", "protected_path", ""),
        ("ls ~/.?*", "protected_path", ""),
        ("ls ~/.con*", "protected_path", ""),
        (
            "false && cd /; cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        (
            "true || cd /; cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        (
            "true |\ncd /; cat ../.aws/credentials",
            "command_path_unknown",
            "cd",
        ),
        ("cd d/..; cat ../.aws/credentials", "protected_path", ""),
        ("cd d; cd ..; cat ../.aws/credentials", "protected_path", ""),
        (
            "rm d; ln -s ~/Documents d; cat d/../.aws/credentials",
            "command_path_unknown",
            "d/../.aws/credentials",
        ),
        ("cat $MISSING_PATH", "command_path_unknown", "MISSING_PATH"),
        ("cat $(pwd)/file", "command_path_unknown", "$(pwd)/file"),
    ] {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        eprintln!(
            "regression command={command} error={} exit={}",
            result["error"], result["exit_code"]
        );
        if result["error"] != error || !result["stderr"].as_str().unwrap_or_default().contains(word)
        {
            failures.push(format!("{command}: {result}"));
        }
    }
    for command in [
        "ls ~/*",
        "ls ~/?*",
        "cd src && printf ordinary",
        "cd src; printf ordinary",
        "cd src\nprintf ordinary",
        "cargo build",
        "cargo build && ls target/debug",
        "npm run build",
        r#"git commit -m "x""#,
        "cd src && make",
    ] {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        if result["exit_code"] != 0 {
            failures.push(format!("{command}: {result}"));
        }
    }
    s.finish().await?;
    server.abort();
    assert!(failures.is_empty(), "followup regressions: {failures:#?}");
    Ok(())
}

#[tokio::test]
async fn foreign_location_guard_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_platform::command_sandbox::{PathSyntax, screen_paths_with};
    let mut setup = Setup::new("FOREIGN-LOCATION-FOLLOWUP")?;
    let cwd = std::fs::canonicalize(&setup.sandbox.workspace)?;
    let env = std::collections::HashMap::new();
    for syntax in [PathSyntax::PowerShell, PathSyntax::Cmd, PathSyntax::Posix] {
        let names: &[&str] = if syntax == PathSyntax::PowerShell {
            &["Set-Location", "Push-Location", "sl", "cd"]
        } else {
            &["cd"]
        };
        for name in names {
            for separator in [" | true;", " &", " ||"] {
                let command = format!("{name} .{separator} cat ../ordinary");
                assert!(
                    !screen_paths_with(&command, &cwd, &env, syntax).complete,
                    "{command}"
                );
            }
            let command = format!("false && {name} . && true; cat ../ordinary");
            assert!(
                !screen_paths_with(&command, &cwd, &env, syntax).complete,
                "{command}"
            );
            for separator in [";", " &&", "\n"] {
                let command = format!("{name} .{separator} cat ordinary");
                let screen = screen_paths_with(&command, &cwd, &env, syntax);
                assert!(screen.complete, "{command}: {screen:?}");
                assert_eq!(
                    screen.candidates.last().unwrap().path,
                    Some(cwd.join("ordinary"))
                );
            }
            let command = format!("{name} missing; cat ordinary");
            assert!(
                !screen_paths_with(&command, &cwd, &env, syntax).complete,
                "{command}"
            );
        }
    }
    for syntax in [PathSyntax::PowerShell, PathSyntax::Cmd, PathSyntax::Posix] {
        let screen = screen_paths_with("cat *aws*/credentials", &cwd, &env, syntax);
        assert_eq!(
            screen
                .candidates
                .last()
                .unwrap()
                .could_access(&cwd.join(".aws")),
            syntax != PathSyntax::Posix
        );
    }
    setup.sandbox.mark_success();
    Ok(())
}

pub(super) fn common_tool_path() -> String {
    let output = std::process::Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let toolchain =
        std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim()).join("bin");
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::iter::once(toolchain).chain(std::env::split_paths(&inherited)))
        .unwrap()
        .to_string_lossy()
        .into_owned()
}
