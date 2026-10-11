//! The command sandbox: read-only commands cannot write, and a protected
//! root cannot be written, by its path or its real path. Hosts without a
//! sandbox refuse read-only commands and report write protection as
//! unavailable.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, ExitStatus};

use butler_platform::command_sandbox::{
    Invocation, Protection, SandboxError, ShellAccess, capabilities, legacy_shell, login_shell,
    protect_writes,
};

use super::scratch;

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
    expected_host_sandbox_is_enforced();
    let read_only = capabilities().read_only.is_enforced();
    let directory = scratch("read-only");
    let target = directory.join("must-not-exist");
    let command = write_command(&[&target]);
    let environment = HashMap::new();
    let sandboxed = login_shell(&command, ShellAccess::ReadOnly, &environment);
    if !read_only {
        assert!(matches!(sandboxed, Err(SandboxError::ReadOnlyUnavailable)));
        return;
    }
    let sandboxed = sandboxed.unwrap();
    if cfg!(target_os = "macos") {
        assert_eq!(sandboxed.program, "/usr/bin/sandbox-exec");
    }
    assert!(!run(&sandboxed).success());
    assert!(!target.exists(), "the sandbox let the command write");

    // The same command with full access writes, so the denial above came
    // from the sandbox.
    let full = login_shell(&command, ShellAccess::Full, &environment).unwrap();
    assert!(run(&full).success());
    assert!(target.exists());
}

// test-category: security
#[test]
fn protected_roots_refuse_writes_by_path_and_real_path() {
    let write_protection = capabilities().write_protection.is_enforced();
    assert_eq!(write_protection, cfg!(target_os = "macos"));
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
        write_protection
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

fn expected_host_sandbox_is_enforced() {
    let Ok(expected) = std::env::var("BUTLER_EXPECT_SANDBOX") else {
        return;
    };
    let caps = capabilities();
    assert!(
        matches!(expected.as_str(), "linux" | "macos" | "unavailable"),
        "unknown BUTLER_EXPECT_SANDBOX contract: {expected}"
    );
    match expected.as_str() {
        "linux" => {
            assert!(caps.approval_free_reads(), "{caps:?}");
            assert!(!caps.write_protection.is_enforced(), "P3 is deferred");
        }
        "macos" => assert!(
            caps.approval_free_reads() && caps.write_protection.is_enforced(),
            "{caps:?}"
        ),
        _ => assert!(!caps.read_only.is_enforced(), "{caps:?}"),
    }
    eprintln!("sandbox capabilities: {caps:?}");
}
