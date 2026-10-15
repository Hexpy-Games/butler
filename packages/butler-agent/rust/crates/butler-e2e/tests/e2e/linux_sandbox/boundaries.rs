//! Regression coverage of metadata, credential and process boundaries.
use super::*;
use std::{
    fmt::Write as _,
    process::{Child, Stdio},
};

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn metadata_syscalls_and_external_signals_are_denied() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    let caps = command_sandbox::capabilities();
    eprintln!("Linux sandbox capabilities: {caps:?}");
    if !caps.read_only.is_enforced() {
        assert!(
            !caps.approval_free_reads(),
            "partial hosts must require approval"
        );
        return Ok(());
    }
    let mut setup = Setup::new("LINUX-METADATA")?;
    let home = &setup.sandbox.home;
    let cwd = &setup.sandbox.workspace;
    std::fs::write(cwd.join("visible.txt"), "complete-original")?;
    let environment = HashMap::from([("HOME".into(), home.display().to_string())]);
    let invoke = |command: &str| {
        command_sandbox::login_shell_contained(command, &environment, &[], &[cwd]).unwrap()
    };
    let invocation = command_sandbox::linux_syscall_probe(&environment, &[cwd]).unwrap();
    let output = run(invocation, cwd, home);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"all-syscalls-covered\n");
    let before = std::fs::metadata(cwd.join("visible.txt"))?;
    for operation in [
        "os.chmod(p, 0o777)",
        "os.chown(p, os.getuid(), os.getgid())",
        "os.utime(p, (1, 1))",
        "os.setxattr(p, 'user.sandbox', b'mutation')",
    ] {
        let script = format!(
            "import os, errno; p='visible.txt'\ntry: {operation}\nexcept OSError as e: assert e.errno==errno.EPERM\nelse: raise AssertionError('metadata mutation escaped')"
        );
        let script = script.replace('\'', "'\"'\"'");
        let output = run(invoke(&format!("python3 -c '{script}'")), cwd, home);
        assert!(output.status.success(), "{operation}: {output:?}");
    }
    assert_eq!(
        std::fs::read(cwd.join("visible.txt"))?,
        b"complete-original"
    );
    assert_eq!(
        std::fs::metadata(cwd.join("visible.txt"))?.modified()?,
        before.modified()?
    );
    assert_eq!(
        butler_platform::secure_fs::file_mode(&std::fs::metadata(cwd.join("visible.txt"))?),
        butler_platform::secure_fs::file_mode(&before)
    );
    // Ordinary shells and parallel sort need pipes/threads, not socket().
    let output = run(
        invoke("printf 'c\\na\\nb\\n' | sort --parallel=2; bash -c 'cat <(printf shell-ok)'"),
        cwd,
        home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"a\nb\nc\nshell-ok");
    let output = run(invoke("seq 100000 -1 1 | sort -n --parallel=2"), cwd, home);
    assert!(output.status.success(), "{output:?}");
    let mut expected = String::new();
    for n in 1..=100_000 {
        writeln!(expected, "{n}").unwrap();
    }
    assert_eq!(output.stdout, expected.as_bytes());
    let output = run(
        invoke(
            "python3 -c 'from multiprocessing import Pipe; a,b=Pipe(); a.send_bytes(b\"worker-ipc\"); assert b.recv_bytes()==b\"worker-ipc\"'",
        ),
        cwd,
        home,
    );
    assert!(output.status.success(), "local stream IPC: {output:?}");
    if caps.process_scoping.is_enforced() {
        let mut child = OwnedChild(
            Command::new("sleep")
                .arg("60")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        );
        let script = format!(
            "import os, signal, errno\ntry: os.kill({}, signal.SIGCONT)\nexcept OSError as e: assert e.errno==errno.EPERM\nelse: raise AssertionError('external signal escaped')",
            child.0.id()
        );
        let script = script.replace('\'', "'\"'\"'");
        let output = run(invoke(&format!("python3 -c '{script}'")), cwd, home);
        assert!(output.status.success(), "external signal: {output:?}");
        assert!(child.0.try_wait()?.is_none());
    } else {
        eprintln!(
            "External signals are not scoped: {:?}",
            caps.process_scoping
        );
    }
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn credential_roots_and_data_auth_stay_denied() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    assert!(command_sandbox::approval_free_reads());
    let mut setup = Setup::new("LINUX-CREDENTIAL-ROOTS")?;
    let home = &setup.sandbox.home;
    let cwd = &setup.sandbox.workspace;
    let data = home.join("relocated-data");
    let roots = [
        ".ssh/key",
        ".gnupg/key",
        ".aws/credentials",
        ".kube/config",
        ".docker/config.json",
        ".config/gcloud/credentials.db",
        ".azure/token",
        ".local/share/keyrings/login",
        ".password-store/password",
        ".config/gh/hosts.yml",
        ".npmrc",
        ".pypirc",
        ".cargo/credentials.toml",
        ".cargo/credentials",
        ".netrc",
        ".git-credentials",
        ".codex/auth.json",
        "external-profile/provider.json",
        "relocated-data/relative-profile.json",
        "relocated-data/auth/provider.json",
    ];
    for name in roots {
        let path = home.join(name);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(path, "private-fixture")?;
    }
    std::fs::write(data.join("ordinary.txt"), "complete-data-file")?;
    let environment = HashMap::from([
        ("HOME".into(), home.display().to_string()),
        ("BUTLER_DATA".into(), data.display().to_string()),
        (
            "BUTLER_CODEX_AUTH_PROFILE".into(),
            home.join("external-profile/provider.json")
                .display()
                .to_string(),
        ),
        (
            "BUTLER_OPENAI_AUTH_PROFILE".into(),
            "relative-profile.json".into(),
        ),
    ]);
    for project in [cwd, &data, home] {
        for name in roots {
            let invocation = command_sandbox::login_shell_contained(
                &format!("cat '{}'", home.join(name).display()),
                &environment,
                &[],
                &[project],
            )
            .unwrap();
            let output = run(invocation, project, home);
            assert!(!output.status.success(), "{name}: {output:?}");
            assert!(output.stdout.is_empty(), "credential contents escaped");
        }
        let invocation = command_sandbox::login_shell_contained(
            &format!("cat '{}'", data.join("ordinary.txt").display()),
            &environment,
            &[],
            &[project],
        )
        .unwrap();
        let output = run(invocation, project, home);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"complete-data-file");
    }
    setup.sandbox.mark_success();
    Ok(())
}
