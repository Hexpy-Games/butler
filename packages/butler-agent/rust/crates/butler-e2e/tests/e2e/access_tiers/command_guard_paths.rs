//! Strict-mode regressions through real approvals; model traffic stays stubbed.
use super::*;
use butler_platform::command_sandbox::{PathSyntax, screen_paths_with};

#[tokio::test]
async fn strict_path_fix_reproductions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("STRICT-PATH-FIX")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    setup.sandbox.workspace = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(setup.sandbox.workspace.join("src"))?;
    std::fs::create_dir_all(setup.sandbox.workspace.join("bin"))?;
    std::fs::create_dir_all(setup.sandbox.home.join(".aws"))?;
    std::fs::write(
        setup.sandbox.home.join(".aws/credentials"),
        "private-marker",
    )?;
    for name in ["touch", "bin/mkdir"] {
        executable(&setup.sandbox.workspace.join(name), "ln -s ../.aws fresh")?;
    }
    let s = setup.start().await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?
            .status,
        200
    );
    let mut failures = Vec::new();
    for command in [
        "cat pipeline/credentials | ln -s src pipeline",
        "cat background/credentials & ln -s src background",
        "./touch; cat fresh/credentials",
        "bin/mkdir; cat fresh/credentials",
        "ln -s ../../.aws/credentials src/y; cat src/y",
    ] {
        let result =
            command_guard::approved_effect(&s, &script, command, Some(1000), "mutation").await?;
        eprintln!(
            "strict_path_repro {command}: error={} exit={}",
            result["error"], result["exit_code"]
        );
        if !matches!(
            result["error"].as_str(),
            Some("command_path_unknown" | "protected_path")
        ) {
            failures.push(format!("{command}: {result}"));
        }
        let fresh = s.sandbox.workspace.join("fresh");
        if std::fs::symlink_metadata(&fresh).is_ok() {
            std::fs::remove_file(fresh)?;
        }
    }
    s.finish().await?;
    server.abort();
    assert!(failures.is_empty(), "unrefused strict paths: {failures:#?}");
    Ok(())
}

#[tokio::test]
async fn strict_glued_cd_fix_reproductions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("STRICT-GLUED-CD-FIX")?;
    let cwd = std::fs::canonicalize(&setup.sandbox.workspace)?;
    let env = std::collections::HashMap::new();
    let mut failures = Vec::new();
    for word in [
        "cd/",
        "chdir\\",
        "chdir..",
        "chdir/",
        "cd../other",
        "chdir.foo",
    ] {
        let screen = screen_paths_with(
            &format!("{word}; Get-Content ordinary"),
            &cwd,
            &env,
            PathSyntax::PowerShell,
        );
        if screen.complete || screen.candidates.last().unwrap().path.is_some() {
            failures.push(format!("{word}: {screen:?}"));
        }
    }
    for (syntax, words) in [
        (PathSyntax::PowerShell, vec!["cd..", "cd\\"]),
        (PathSyntax::Cmd, vec!["cd..", "chdir..", "cd\\", "chdir\\"]),
    ] {
        for word in words {
            let screen = screen_paths_with(&format!("{word}; type ordinary"), &cwd, &env, syntax);
            assert!(screen.complete, "{syntax:?} {word}: {screen:?}");
        }
    }
    setup.sandbox.mark_success();
    assert!(
        failures.is_empty(),
        "glued cd falsely complete: {failures:#?}"
    );
    Ok(())
}

#[tokio::test]
async fn strict_link_program_categories() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("STRICT-LINK-CATEGORIES")?;
    let cwd = std::fs::canonicalize(&setup.sandbox.workspace)?;
    let env = std::collections::HashMap::new();
    for syntax in [PathSyntax::Posix, PathSyntax::Cmd, PathSyntax::PowerShell] {
        for program in [
            "ln -s x y",
            "link x y",
            "cp -s x y",
            "cp -l x y",
            "cp -a x y",
            "cp -R x y",
            "cp -r x y",
            "cp -P x y",
            "cp -d x y",
            "cp -fvR x y",
            "rsync x y",
            "tar xf x",
            "bsdtar xf x",
            "unzip x",
            "7z x y",
            "cpio x",
            "pax x",
            "git checkout x",
            "git clone x",
            "git apply x",
            "git stash",
            "git reset",
            "git worktree list",
            "git submodule update",
            "git -C . checkout x",
            "mklink x y",
            "New-Item -ItemType SymbolicLink x",
            "New-Item -ItemType Junction x",
            "New-Item -ItemType HardLink x",
            "fsutil hardlink create x y",
            "./touch",
            "bin/mkdir",
            "sh -c x",
            "bash -c x",
            "python -c x",
            "node -e x",
            "perl -e x",
            "ruby -e x",
            "pwsh -c x",
            "cmd /c x",
        ] {
            let command = format!("cat missing/file | {program}");
            assert!(
                !screen_paths_with(&command, &cwd, &env, syntax).complete,
                "{syntax:?}: {command}"
            );
        }
        for program in [
            "cargo build",
            "npm run build",
            "make",
            "go build",
            "pytest",
            "cp x y",
            "git status",
            "git add -A",
            "git commit -m x",
        ] {
            let command = format!("{program}; cat missing/file");
            assert!(
                screen_paths_with(&command, &cwd, &env, syntax).complete,
                "{syntax:?}: {command}"
            );
        }
    }
    setup.sandbox.mark_success();
    Ok(())
}

fn executable(path: &std::path::Path, body: &str) -> Result<(), HarnessError> {
    std::fs::write(path, format!("#!/bin/sh\nset -eu\n{body}\n"))?;
    butler_platform::secure_fs::set_file_mode(
        path,
        butler_platform::secure_fs::FileMode::EXECUTABLE,
    )
    .unwrap()?;
    Ok(())
}

#[tokio::test]
async fn strict_default_tier_approved_build_flows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::POSIX_SHELL,
        "POSIX commands"
    );
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("STRICT-DEFAULT-BUILDS")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let project = &setup.sandbox.workspace;
    std::fs::create_dir_all(project.join("src"))?;
    std::fs::create_dir_all(project.join("sub"))?;
    std::fs::write(project.join("src/main.rs"), "// TODO foo\n")?;
    let tools = setup.sandbox.home.join("tools");
    std::fs::create_dir_all(&tools)?;
    executable(
        &tools.join("cargo"),
        "case \"$1\" in build) mkdir -p target/debug; printf cargo-output > target/debug/app;; test) printf cargo-tested;; *) exit 2;; esac",
    )?;
    executable(
        &tools.join("npm"),
        "case \"$*\" in 'run build') mkdir -p build; printf npm-output > build/out.js;; test) printf npm-tested;; *) exit 2;; esac",
    )?;
    // Select a runnable installed rg; PATH may include a foreign-architecture
    // binary before the native one on developer hosts.
    let rg = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|directory| directory.join("rg"))
        .find(|program| {
            std::process::Command::new(program)
                .arg("--version")
                .output()
                .is_ok_and(|output| output.status.success())
        })
        .ok_or_else(|| HarnessError("No runnable rg on PATH".into()))?;
    std::fs::copy(rg, tools.join("rg"))?;
    let path = std::env::join_paths(
        std::iter::once(tools).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap()
    .to_string_lossy()
    .into_owned();
    let setup = setup.env("PATH", path);
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&setup.sandbox.workspace)
                .status()?
                .success()
        );
    }
    assert!(!setup.sandbox.workspace.join("target").exists());
    assert!(!setup.sandbox.workspace.join("dist").exists());
    let s = setup.start().await?;
    assert_eq!(s.gw.settings().await?["access_mode"], "ask_except_reads");
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], true);
    let mut failures = Vec::new();
    for (command, expected) in [
        (
            "mkdir -p dist && cargo build && cp target/debug/app dist/app",
            "",
        ),
        ("npm run build && cp build/out.js out.js", ""),
        ("cd . && cargo test", "cargo-tested"),
        ("cd sub && npm test", "npm-tested"),
        ("git status && git add -A && git commit -m x", ""),
        ("git checkout -b x", ""),
        ("find . -name '*.rs'", "./src/main.rs"),
        ("grep -rn TODO src", "TODO foo"),
        ("rg foo", "TODO foo"),
    ] {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        eprintln!(
            "default_tier_approved {command}: error={} exit={}",
            result["error"], result["exit_code"]
        );
        if !result["error"].is_null()
            || result["exit_code"] != 0
            || !result["stdout"]
                .as_str()
                .unwrap_or_default()
                .contains(expected)
        {
            failures.push(format!("{command}: {result}"));
        }
    }
    if failures.is_empty() {
        assert_eq!(
            std::fs::read_to_string(s.sandbox.workspace.join("dist/app"))?,
            "cargo-output"
        );
        assert_eq!(
            std::fs::read_to_string(s.sandbox.workspace.join("out.js"))?,
            "npm-output"
        );
    }
    s.finish().await?;
    server.abort();
    assert!(failures.is_empty(), "approved flows refused: {failures:#?}");
    Ok(())
}

#[tokio::test]
async fn strict_native_invalid_glued_cd() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows shell"
    );
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("STRICT-INVALID-CD")?
        .access(Access::AskAlways)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    setup.sandbox.workspace = setup.sandbox.home.join("proj");
    std::fs::create_dir_all(&setup.sandbox.workspace)?;
    std::fs::create_dir_all(setup.sandbox.home.join(".aws"))?;
    std::fs::write(
        setup.sandbox.home.join(".aws/credentials"),
        "private-marker",
    )?;
    let s = setup.start().await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"command_sandbox_enabled":false}))
            .await?
            .status,
        200
    );
    for command in [
        "cd/; Get-Content ../.aws/credentials",
        "chdir\\; Get-Content ../.aws/credentials",
        "chdir..; Get-Content ../.aws/credentials",
    ] {
        let result = command_guard::approved_effect(&s, &script, command, None, "mutation").await?;
        assert_eq!(
            result["error"], "command_path_unknown",
            "{command}: {result}"
        );
        assert!(!result.to_string().contains("private-marker"));
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
