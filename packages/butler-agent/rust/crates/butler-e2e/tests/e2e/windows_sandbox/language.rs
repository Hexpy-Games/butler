use super::*;

#[test]
fn language_policy_probe() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-LANGUAGE")?;
    let probe = std::env::var("BUTLER_E2E_WINDOWS_POLICY_PROBE")
        .map_err(|_| HarnessError("policy probe executable required".into()))?;
    std::fs::copy(probe, f.root.join("policy-probe.exe"))?;
    // Explicit cmd bypasses Butler's PowerShell prelude. The mode and policy
    // evidence must remain observable even if that prelude fails to initialize.
    std::fs::write(
        f.root.join("language.ps1"),
        "$ExecutionContext.SessionState.LanguageMode; & .\\policy-probe.exe; exit $LASTEXITCODE\r\n",
    )?;
    let script = "cmd /c powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -File language.ps1";
    // Compare the same executable, script, temp profile and desktop session.
    // An SSH baseline cannot distinguish desktop policy from container policy.
    let plain = command_sandbox::login_shell(script, command_sandbox::ShellAccess::Full, &f.env)
        .map_err(|error| HarnessError(error.to_string()))?;
    let baseline = f.launch(&plain);
    eprintln!(
        "Desktop host language policy:\n{}",
        String::from_utf8_lossy(&baseline.stdout)
    );
    assert!(baseline.status.success(), "{baseline:?}");
    assert!(
        String::from_utf8_lossy(&baseline.stdout).contains("system_policy="),
        "{baseline:?}"
    );
    let output = f.pass(script);
    let text = String::from_utf8_lossy(&output.stdout);
    eprintln!("Contained language policy:\n{text}");
    assert!(
        text.lines().any(|line| line == "FullLanguage"),
        "{output:?}"
    );
    for marker in [
        "TEMP_under_limit=True",
        "TMP_under_limit=True",
        "temp_matches_env=True",
        "temp_under_limit=True",
    ] {
        assert!(text.contains(marker), "{output:?}");
    }
    assert!(text.contains("temp_removed=True"), "{output:?}");
    assert!(text.contains("temp_roundtrip=True"), "{output:?}");
    assert!(text.contains("system_policy="), "{output:?}");
    assert!(text.contains("system_policy=None"), "{output:?}");
    // -File can be FullLanguage even when the initial runspace is constrained.
    // Exercise both a fresh -Command and Butler's normal command prelude.
    for script in [
        r#"cmd /c powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ExecutionContext.SessionState.LanguageMode""#,
        "$ExecutionContext.SessionState.LanguageMode; [System.Text.UTF8Encoding]::new($false).WebName",
    ] {
        let output = f.pass(script);
        let text = String::from_utf8_lossy(&output.stdout);
        eprintln!("Contained command language: {text}");
        assert!(
            text.lines().any(|line| line == "FullLanguage"),
            "{output:?}"
        );
        assert!(!text.contains("ConstrainedLanguage"), "{output:?}");
    }
    assert_eq!(std::fs::read_dir(&f.scratch[0])?.count(), 0);
    assert_eq!(
        std::fs::read_dir(f.setup.sandbox.data.join("sandbox/drives"))?.count(),
        0
    );
    f.finish();
    Ok(())
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
