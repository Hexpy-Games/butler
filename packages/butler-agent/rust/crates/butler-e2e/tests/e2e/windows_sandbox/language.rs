use super::*;

#[test]
fn language_policy_probe() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-LANGUAGE")?;
    let probe = std::env::var("BUTLER_E2E_WINDOWS_POLICY_PROBE")
        .map_err(|_| HarnessError("policy probe executable required".into()))?;
    std::fs::copy(probe, f.root.join("policy-probe.exe"))?;
    std::fs::write(
        f.root.join("language-mode.ps1"),
        "$ExecutionContext.SessionState.LanguageMode\r\n",
    )?;
    std::fs::write(
        f.root.join("language.ps1"),
        include_str!("../../../../butler-platform/tests/support/windows-language-matrix.ps1"),
    )?;
    let script = "cmd /c powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -File language.ps1";
    let plain = command_sandbox::login_shell(script, command_sandbox::ShellAccess::Full, &f.env)
        .map_err(|error| HarnessError(error.to_string()))?;
    let baseline = f.launch(&plain);
    let contained = f.run(script);
    let product = f.run("$ExecutionContext.SessionState.LanguageMode; [System.Text.UTF8Encoding]::new($false).WebName");
    let matrix = serde_json::json!({
        "host": matrix_output(&baseline), "contained": matrix_output(&contained),
        "product": {"exitCode": product.status.code(),
            "stdout": String::from_utf8_lossy(&product.stdout),
            "stderr": String::from_utf8_lossy(&product.stderr)}
    });
    // Emit before assertions: one failed probe must not hide the other modes.
    eprintln!("WINDOWS_LANGUAGE_MATRIX={matrix}");
    assert!(baseline.status.success(), "{matrix}");
    assert!(contained.status.success(), "{matrix}");
    assert_eq!(
        matrix["contained"]["data"]["fileMode"], "FullLanguage",
        "{matrix}"
    );
    assert!(product.status.success(), "{matrix}");
    let text = String::from_utf8_lossy(&product.stdout);
    assert!(text.lines().any(|line| line == "FullLanguage"), "{matrix}");
    assert!(text.lines().any(|line| line == "utf-8"), "{matrix}");
    for extension in ["ps1", "psm1"] {
        assert_eq!(
            matrix["contained"]["data"]["policy"][format!("policy_file_{extension}_roundtrip")],
            "True",
            "{matrix}"
        );
    }
    assert_eq!(std::fs::read_dir(&f.scratch[0])?.count(), 0);
    assert_eq!(
        std::fs::read_dir(f.setup.sandbox.data.join("sandbox/drives"))?.count(),
        0
    );
    f.finish();
    Ok(())
}
fn matrix_output(output: &Output) -> serde_json::Value {
    serde_json::json!({"exitCode": output.status.code(),
        "data": serde_json::from_slice::<serde_json::Value>(&output.stdout).ok(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)})
}

#[test]
fn host_state_attribution() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows required");
    let f = Fixture::new("WIN-HOST-ATTRIBUTION")?;
    for (name, source) in [
        (
            "windows-host-snapshot.ps1",
            include_str!("../../../../butler-platform/tests/support/windows-host-snapshot.ps1"),
        ),
        (
            "windows-host-snapshot-test.ps1",
            include_str!(
                "../../../../butler-platform/tests/support/windows-host-snapshot-test.ps1"
            ),
        ),
    ] {
        std::fs::write(f.root.join(name), source)?;
    }
    let output = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
        .arg(f.root.join("windows-host-snapshot-test.ps1"))
        .envs(&f.env)
        .output()?;
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("host_attribution_complete"));
    f.finish();
    Ok(())
}
