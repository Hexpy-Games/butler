//! Offline toolchain behavior and host Git independence during a private mount.
use super::*;
use std::io::BufRead;

fn invoke(command: &str, root: &Path, setup: &Setup) -> Invocation {
    command_sandbox::project_write_shell(
        command,
        &HashMap::from([("HOME".into(), setup.sandbox.home.display().to_string())]),
        root,
        &[&setup.sandbox.data.join("tmp/project-write")],
        &[&setup.sandbox.data],
    )
    .unwrap()
}

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn host_git_is_independent_of_secret_masks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux host Git independence"
    );
    let mut setup = Setup::new("LINUX-HOST-GIT")?;
    let root = &setup.sandbox.workspace;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    assert!(
        Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(root)
            .status()?
            .success()
    );
    std::fs::write(root.join("visible"), "complete")?;
    let before = std::fs::read("/proc/self/mountinfo")?;
    let invocation = invoke("echo ready; exec sleep 30", root, &setup);
    let mut child = ChildGuard(
        Command::new(invocation.program)
            .args(invocation.arguments)
            .current_dir(root)
            .env("HOME", &setup.sandbox.home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?,
    );
    let mut ready = String::new();
    std::io::BufReader::new(child.0.stdout.take().unwrap()).read_line(&mut ready)?;
    assert_eq!(ready, "ready\n");
    let git = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain"])
        .output()?;
    assert!(git.status.success(), "{git:?}");
    assert_eq!(git.stdout, b"?? visible\n");
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["config", "butler.fixture", "complete"])
            .status()?
            .success()
    );
    assert!(
        child.0.try_wait()?.is_none(),
        "sandbox exited before host checks"
    );
    child.0.kill()?;
    child.0.wait()?;
    assert_eq!(std::fs::read("/proc/self/mountinfo")?, before);
    assert!(std::fs::read_to_string(root.join(".git/config"))?.contains("complete"));
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn offline_generated_toolchains() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux offline toolchains"
    );
    let mut setup = Setup::new("LINUX-OFFLINE-TOOLCHAINS")?;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let mut failures = Vec::new();
    for declared in [false, true] {
        for tool in ["npm", "cargo", "python"] {
            let root = setup.sandbox.workspace.join(format!("{tool}-{declared}"));
            std::fs::create_dir_all(&root)?;
            if declared {
                std::fs::write(root.join(".gitignore"), "node_modules\ntarget\n.venv\n")?;
            }
            let command = fixture(tool, &root, &setup)?;
            let preparation = command_sandbox::prepare_project_write(&root, &setup.sandbox.data)?;
            let inventory = command_sandbox::discover_project_secrets(&root)?;
            let invocation = invoke(&command, &root, &setup);
            let policy: Value = serde_json::from_str(&invocation.arguments[1])?;
            let output = run(invocation, &root, &setup.sandbox.home);
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!(
                "toolchain {tool} declared={declared} exit={} stderr={stderr}",
                output.status
            );
            let moved = command_sandbox::sweep_new_secrets(&root, &inventory, &setup.sandbox.data)?;
            for path in moved {
                assert!(!path.exists(), "new secret remained in project");
            }
            preparation.release();

            // A refused command must still leave its source inputs intact.
            if tool == "cargo" {
                assert_eq!(
                    std::fs::read_to_string(root.join("src/main.rs"))?,
                    "fn main() {}\n"
                );
            }
            // M+ runs every tool. Tier L creates no top-level names and denies
            // chmod/utimensat, so a tool needs a declared directory, and one
            // whose output needs no chmod: Cargo's target, and npm's symlink
            // for a `file:` dependency. An undeclared project, and a Python
            // venv (ensurepip copies modes), must ask.
            let expected = policy["mountns_plus"] == true
                || (declared && matches!(tool, "cargo" | "npm"))
                || (policy["mountns"] == true && tool == "cargo");
            if output.status.success() != expected {
                failures.push(format!("{tool} declared={declared}: {}", output.status));
            }
            // Any contained failure carries the approval retry hint
            // (project_write_limits); a refusal needs no stderr signature.
            if !output.status.success() {
                continue;
            }
            let generated = match tool {
                "npm" => "node_modules/local/package.json",
                "cargo" => "target/debug/minimal",
                _ => ".venv/bin/pip",
            };
            assert!(
                root.join(generated).exists(),
                "missing complete {tool} output"
            );
        }
    }
    assert!(failures.is_empty(), "toolchain tier mismatch: {failures:?}");
    setup.sandbox.mark_success();
    Ok(())
}

fn fixture(tool: &str, root: &Path, setup: &Setup) -> Result<String, HarnessError> {
    match tool {
        "npm" => {
            std::fs::create_dir(root.join("local"))?;
            std::fs::write(
                root.join("local/package.json"),
                r#"{"name":"local","version":"1.0.0"}"#,
            )?;
            std::fs::write(
                root.join("package.json"),
                r#"{"name":"minimal","version":"1.0.0","dependencies":{"local":"file:./local"}}"#,
            )?;
            Ok(format!(
                "npm install --offline --package-lock=false --cache '{}'",
                setup
                    .sandbox
                    .data
                    .join("tmp/project-write/npm-cache")
                    .display()
            ))
        }
        "cargo" => {
            std::fs::create_dir(root.join("src"))?;
            std::fs::write(root.join("src/main.rs"), "fn main() {}\n")?;
            std::fs::write(
                root.join("Cargo.toml"),
                "[package]\nname=\"minimal\"\nversion=\"0.1.0\"\nedition=\"2024\"\n",
            )?;
            // An existing lock file separates generated-directory support from
            // the deliberately withheld Tier L top-level creation right.
            std::fs::write(
                root.join("Cargo.lock"),
                "version = 4\n[[package]]\nname = \"minimal\"\nversion = \"0.1.0\"\n",
            )?;
            // The default system linker, with guided commands' scratch TMPDIR;
            // a build host's own linker override (e.g. mold, which aborts when
            // Tier L denies fchmod) is not the toolchain under test.
            Ok(format!(
                "env -u CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER \
                 -u CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS TMPDIR='{}' \
                 RUSTC_WRAPPER= CARGO_TARGET_DIR=target cargo build --offline -j 1",
                setup.sandbox.data.join("tmp/project-write").display()
            ))
        }
        _ => Ok("python3 -m venv .venv".into()),
    }
}

#[tokio::test]
async fn fresh_git_init_is_quarantined_even_when_metadata_is_denied() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux fresh Git containment"
    );
    let mut setup = Setup::new("LINUX-FRESH-GIT")?;
    let root = &setup.sandbox.workspace;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let inventory = command_sandbox::discover_project_secrets(root)?;
    let output = run(
        invoke("git init --quiet", root, &setup),
        root,
        &setup.sandbox.home,
    );
    let mounted = command_sandbox::capabilities().project_write.is_enforced();
    let moved = command_sandbox::sweep_new_secrets(root, &inventory, &setup.sandbox.data)?;
    assert_eq!(moved.len(), usize::from(mounted), "{output:?}");
    assert!(!root.join(".git").exists());
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn node_atomic_lockfile_preserves_complete_content() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux atomic lockfile");
    let mut setup = Setup::new("LINUX-ATOMIC-LOCKFILE")?;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let mounted = command_sandbox::capabilities().project_write.is_enforced();
    for existing in [false, true] {
        let root = setup.sandbox.workspace.join(format!("atomic-{existing}"));
        std::fs::create_dir(&root)?;
        std::fs::write(root.join("package.json"), "{}")?;
        if existing {
            std::fs::write(root.join("lockfile"), "original")?;
        }
        let command = r#"node -e 'require("write-file-atomic")("lockfile", "complete").catch(() => process.exit(1))'"#;
        let output = run(invoke(command, &root, &setup), &root, &setup.sandbox.home);
        assert_eq!(
            output.status.success(),
            mounted,
            "existing={existing}: {output:?}"
        );
        if mounted || existing {
            assert_eq!(
                std::fs::read_to_string(root.join("lockfile"))?,
                if mounted { "complete" } else { "original" }
            );
        } else {
            assert!(!root.join("lockfile").exists());
        }
    }
    setup.sandbox.mark_success();
    Ok(())
}
