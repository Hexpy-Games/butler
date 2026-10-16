//! Request/response protocol through the real PowerShell consumer.
use super::*;

#[test]
fn desktop_request_protocol() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows PowerShell required");
    let f = Fixture::new("WIN-DESKTOP-QUEUE")?;
    for (name, source) in [
        (
            "desktop-runner-job.cs",
            include_str!("../../../../butler-platform/tests/support/desktop-runner-job.cs"),
        ),
        (
            "desktop-runner.ps1",
            include_str!("../../../../butler-platform/tests/support/desktop-runner.ps1"),
        ),
        (
            "bundle-common.ps1",
            include_str!("../../../../butler-platform/tests/support/bundle-common.ps1"),
        ),
        (
            "desktop-runner-test.ps1",
            include_str!("../../../../butler-platform/tests/support/desktop-runner-test.ps1"),
        ),
    ] {
        std::fs::write(f.root.join(name), source)?;
    }
    let output = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
        .arg(f.root.join("desktop-runner-test.ps1"))
        .arg("-Root")
        .arg(f.root.join("queue"))
        .envs(&f.env)
        .output()?;
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("DESKTOP_RUNNER_PROTOCOL=PASS"));
    f.finish();
    Ok(())
}
