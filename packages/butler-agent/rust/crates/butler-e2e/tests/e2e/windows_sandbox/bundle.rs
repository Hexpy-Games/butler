//! Bundle-only setup coverage; no contained process or host setting is changed.
use super::*;
use butler_e2e::e2e::{cassette::Cassette, scenario::Access};

#[tokio::test]
async fn every_row_setup_from_bundle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows bundle required");
    // The same Fixture constructor as the desktop rows copies the agent,
    // helper and resources and creates the isolated Unicode project/profile.
    for row in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14] {
        let mut f = Fixture::new(&format!("WIN-{row:02}"))?;
        if row == 0 || row == 2 {
            let probe = std::env::var("BUTLER_E2E_WINDOWS_POLICY_PROBE")
                .map_err(|error| HarnessError(error.to_string()))?;
            std::fs::copy(probe, f.root.join("policy-probe.exe"))?;
        }
        if row == 10 {
            let length = f.root.to_string_lossy().encode_utf16().count();
            assert!(length < 229, "fixture root leaves no room for a long grant");
            f.root = f.root.join("l".repeat(229 - length));
            std::fs::create_dir_all(&f.root)?;
        }
        // Exercises helper discovery, secret discovery, ledger/prewarm and
        // tool/profile staging. Stop before launching the desktop-only MXC.
        let invocation = f.prepare("cmd /c echo complete");
        assert!(Path::new(&invocation.program).is_file());
        let policy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&invocation.arguments[1])?)?;
        assert!(policy["request"].is_object());
        command_sandbox::cleanup_prepared_invocation(&invocation)?;
        drop(invocation);
        f.finish();
        eprintln!("BUNDLE_SETUP row={row} PASS");
    }
    for row in [9, 11, 12, 15] {
        agent_setup(row).await?;
    }
    Ok(())
}

async fn agent_setup(row: u8) -> Result<(), HarnessError> {
    let setup = Setup::new(&format!("WIN-{row:02}-AGENT"))?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?);
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir(&folder)?;
    let mut scenario = setup.start().await?;
    super::super::project_workspace::bind_project(&mut scenario, &folder).await?;
    // Explicitly stop so startup/prewarm failures and shutdown failures both
    // fail the build, before an owner has to open a desktop console.
    scenario.agent.terminate().await?;
    scenario.finish().await?;
    eprintln!("BUNDLE_SETUP row={row} agent=PASS");
    Ok(())
}

#[test]
fn desktop_request_protocol() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows PowerShell required");
    let f = Fixture::new("WIN-DESKTOP-QUEUE")?;
    for (name, source) in [
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
