//! The command sandbox: read-only commands cannot write, and a protected
//! root cannot be written, by its path or its real path. Hosts without a
//! sandbox refuse read-only commands and report write protection as
//! unavailable.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, ExitStatus};

use butler_platform::command_sandbox::{
    Invocation, Protection, READ_ONLY_SANDBOX, SandboxError, ShellAccess, WRITE_PROTECTION,
    legacy_shell, login_shell, protect_writes,
};

use super::scratch;

// Pin the Windows invocation plan on Linux too; native E2Es verify cmd parsing.
#[path = "../../src/command_sandbox/windows/cmd.rs"]
mod cmd;

fn run(invocation: &Invocation) -> ExitStatus {
    Command::new(&invocation.program)
        .args(&invocation.arguments)
        .status()
        .unwrap()
}

fn write_command(targets: &[&Path]) -> String {
    targets
        .iter()
        .map(|target| format!("printf x > '{}'", target.display()))
        .collect::<Vec<_>>()
        .join("; ")
}

// test-category: security
#[test]
fn read_only_commands_run_sandboxed_or_are_refused() {
    cmd_arguments_remain_verbatim();
    assert_eq!(READ_ONLY_SANDBOX, cfg!(target_os = "macos"));
    let directory = scratch("read-only");
    let target = directory.join("must-not-exist");
    let command = write_command(&[&target]);
    let environment = HashMap::new();
    let sandboxed = login_shell(&command, ShellAccess::ReadOnly, &environment);
    if !READ_ONLY_SANDBOX {
        assert!(matches!(sandboxed, Err(SandboxError::ReadOnlyUnavailable)));
        return;
    }
    let sandboxed = sandboxed.unwrap();
    assert_eq!(sandboxed.program, "/usr/bin/sandbox-exec");
    assert!(!run(&sandboxed).success());
    assert!(!target.exists(), "the sandbox let the command write");

    // The same command with full access writes, so the denial above came
    // from the sandbox.
    let full = login_shell(&command, ShellAccess::Full, &environment).unwrap();
    assert!(run(&full).success());
    assert!(target.exists());
}

fn cmd_arguments_remain_verbatim() {
    let environment = HashMap::from([("ComSpec".into(), Some("cmd.exe".into()))]);
    for text in [
        r#"cmd.exe /d /c "echo 한국어 출력""#,
        r#"cmd /c dir "%USERPROFILE%\Downloads""#,
        r#"cmd /s /c "echo 한국어 출력 & dir "%USERPROFILE%\Downloads"""#,
        r#"cmd /c echo 한국어 출력 & dir "C:\Directory with spaces""#,
        r#"cmd /s /c echo 한국어 출력 & dir "C:\Directory with spaces""#,
        r"cmd.exe /d /c echo 한국어 출력",
        r#"cmd /c ""C:\Program Files\tool.exe" "한국어 인수"""#,
        r#"cmd /s /c ""C:\Program Files\tool.exe" "%USERPROFILE%\Downloads"""#,
    ] {
        assert!(cmd::script(text).is_some(), "{text}");
        let invocation = cmd::shell(text, &environment);
        assert_eq!(invocation.program, "cmd.exe");
        assert_eq!(
            invocation.arguments,
            ["/d", "/s", "/c", &format!("chcp 65001>nul & {text}")]
        );
        assert_eq!(
            cmd::raw_argument(&invocation).as_deref(),
            Some(format!("\"chcp 65001>nul & {text}\"").as_str())
        );
    }
    let native = Invocation {
        program: "node.exe".into(),
        arguments: vec!["/d".into(), "/s".into(), "/c".into(), "quoted text".into()],
    };
    assert_eq!(cmd::raw_argument(&native), None);
    assert_eq!(cmd::script("Write-Output '한국어 출력'"), None);
}

#[test]
fn protected_roots_refuse_writes_by_path_and_real_path() {
    assert_eq!(WRITE_PROTECTION, cfg!(target_os = "macos"));
    let directory = scratch("protect-writes");
    let root = directory.join("installation");
    let outside = directory.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    // The scratch directory may itself sit behind a link (macOS /var is
    // /private/var), so the real path is protected too.
    let real_root = root.canonicalize().unwrap();
    let blocked = [root.join("by-path"), real_root.join("by-real-path")];
    let allowed = outside.join("allowed");
    let command = write_command(&[&blocked[0], &blocked[1], &allowed]);
    let shell = legacy_shell(&command, false, &HashMap::new());
    let protection = protect_writes(shell.clone(), &root).unwrap();
    assert_eq!(
        matches!(protection, Protection::Enforced(_)),
        WRITE_PROTECTION
    );
    match protection {
        Protection::Unavailable(unchanged) => assert_eq!(unchanged, shell),
        Protection::Enforced(protected) => {
            assert_eq!(protected.program, "/usr/bin/sandbox-exec");
            run(&protected);
            for path in &blocked {
                assert!(!path.exists(), "{} was written", path.display());
            }
            assert!(allowed.exists(), "a write outside the root was refused");
        }
    }
}
