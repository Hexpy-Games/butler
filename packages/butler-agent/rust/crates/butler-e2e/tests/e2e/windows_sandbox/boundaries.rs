use super::*;

#[test]
fn row05_credentials() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-05")?;
    for name in [
        ".ssh/id_rsa",
        ".aws/credentials",
        ".azure/token",
        ".kube/config",
        ".docker/config.json",
        ".gnupg/private",
        "roaming/Microsoft/Credentials/fixture",
    ] {
        let path = f.setup.sandbox.home.join(name);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, "fixture-credential")?;
        let output = f.deny(&format!(
            "$ErrorActionPreference='Stop'; [IO.File]::ReadAllText({})",
            quote(&path)
        ));
        assert!(!output.status.success(), "{output:?}");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-credential"));
    }
    let output = f.run("cmdkey /list; exit $LASTEXITCODE");
    assert!(
        !String::from_utf8_lossy(&output.stderr)
            .contains("command_observation_isolation_unavailable"),
        "{output:?}"
    );
    let text = String::from_utf8_lossy(&output.stdout);
    // cmdkey succeeds with an empty list on some Windows builds. No credential
    // identifiers may be returned even when the host already has credentials.
    assert!(
        !text.contains("Target:") && !text.contains("대상:"),
        "credential metadata escaped: {text}"
    );
    // CredRead is exercised without creating any Credential Manager entry.
    f.pass(include_str!("credread.ps1"));
    f.finish();
    Ok(())
}

#[test]
fn row06_registry_tasks_wmi() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-06")?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    // Only these contained calls attempt writes. The harness snapshots HKCU
    // and the complete task definitions before and after this row.
    f.deny(&format!("cmd /c reg add HKCU\\Software\\ButlerSandboxDenied\\{nonce} /v blocked /t REG_SZ /d denied /f"));
    f.deny(&format!("cmd /c schtasks /create /tn ButlerSandboxDenied-{nonce} /tr \"cmd /c exit 0\" /sc ONCE /st 23:59"));
    f.pass("$ErrorActionPreference='Stop'; try { $r=Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'cmd /c exit 0'; if ($r.ReturnValue -eq 0) {exit 1} } catch {exit 0}");
    f.finish();
    Ok(())
}

#[test]
fn row07_alias_escapes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-07")?;
    let outside = f.setup.sandbox.home.join("outside");
    std::fs::create_dir(&outside)?;
    std::fs::write(outside.join("private.txt"), "outside-secret")?;
    let alias = f.root.join("alias");
    let output = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&alias)
        .arg(&outside)
        .output()?;
    assert!(output.status.success(), "junction fixture: {output:?}");
    f.deny("$ErrorActionPreference='Stop'; [IO.File]::ReadAllText('alias\\private.txt')");
    f.deny("$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('alias\\escape','escape')");
    // An inner subst must not make an ungranted physical target readable.
    let output = f.deny(&format!(
        "cmd /c \"subst Q: {} && type Q:\\private.txt\"",
        outside.display()
    ));
    assert!(!output.status.success(), "inner subst escape: {output:?}");
    std::fs::write(f.root.join("internal.txt"), "original")?;
    std::fs::hard_link(
        f.root.join("internal.txt"),
        f.root.join("internal-alias.txt"),
    )?;
    f.pass(
        "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('internal-alias.txt','complete')",
    );
    assert_eq!(std::fs::read(f.root.join("internal.txt"))?, b"complete");
    std::fs::hard_link(outside.join("private.txt"), f.root.join("linked.txt"))?;
    let secrets = command_sandbox::discover_project_secrets(&f.root)?;
    let invocation = command_sandbox::windows_prepare_project_write(
        "cmd /c type linked.txt",
        &f.env,
        &f.root,
        &f.scratch.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
        &secrets.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
    );
    assert!(
        invocation.is_err(),
        "hard-link aliases must refuse admission"
    );
    assert_eq!(
        std::fs::read(outside.join("private.txt"))?,
        b"outside-secret"
    );
    assert!(!outside.join("escape").exists());
    f.finish();
    Ok(())
}

#[tokio::test]
async fn row09_network() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-09")?;
    let agent = Setup::new("WIN-09-AGENT")?
        .cassette("TOOL-01")
        .start()
        .await?;
    let agent_port = agent.agent.launch.port;
    let tcp = std::net::TcpListener::bind("127.0.0.1:0")?;
    tcp.set_nonblocking(true)?;
    let v6 = std::net::TcpListener::bind("[::1]:0")?;
    v6.set_nonblocking(true)?;
    for (host, port) in [
        ("1.1.1.1", 443),
        ("127.0.0.1", agent_port),
        ("127.0.0.1", tcp.local_addr()?.port()),
        ("::1", v6.local_addr()?.port()),
    ] {
        network_probe(&f, "tcp", host, port)?;
    }
    // Remove the successful baseline handshakes before checking the sandbox.
    tcp.accept()?;
    v6.accept()?;
    network_probe(&f, "dns", "example.com", 0)?;
    assert_eq!(
        tcp.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        v6.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    agent.finish().await?;
    f.finish();
    Ok(())
}

fn network_probe(f: &Fixture, kind: &str, host: &str, port: u16) -> Result<(), HarnessError> {
    std::fs::write(
        f.root.join("network-probe.cjs"),
        include_str!("network-probe.cjs"),
    )?;
    let script = format!(
        "$ErrorActionPreference='Stop'; node .\\network-probe.cjs {kind} '{host}' {port}; exit $LASTEXITCODE"
    );
    let plain =
        command_sandbox::login_shell(&script, command_sandbox::ShellAccess::Full, &f.env).unwrap();
    let baseline = f.launch(&plain);
    assert!(
        baseline.status.success(),
        "host {kind} {host}:{port}: {baseline:?}"
    );
    let report: serde_json::Value = serde_json::from_slice(&baseline.stdout)?;
    assert_eq!(report["outcome"], "connected", "{baseline:?}");
    let blocked = f.run(&script);
    eprintln!("network {kind} {host}:{port}: {blocked:?}");
    // Missing tools, CLM exceptions and lost stdout are test failures, never
    // evidence of network denial. The probe writes its result synchronously.
    let report = serde_json::from_slice::<serde_json::Value>(&blocked.stdout);
    assert!(report.is_ok(), "network probe did not report: {blocked:?}");
    let report = report?;
    assert!(!blocked.status.success(), "{blocked:?}");
    assert!(
        matches!(report["outcome"].as_str(), Some("error" | "timeout")),
        "{report}"
    );
    assert!(blocked.stderr.is_empty(), "{blocked:?}");
    Ok(())
}
