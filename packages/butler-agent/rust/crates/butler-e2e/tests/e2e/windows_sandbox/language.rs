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
    assert!(text.contains("Language"), "{output:?}");
    assert!(text.contains("temp_roundtrip=True"), "{output:?}");
    assert!(text.contains("system_policy="), "{output:?}");
    f.finish();
    Ok(())
}
