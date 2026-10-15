//! Admission can be checked over SSH without claiming container qualification.
use super::*;

#[test]
fn admission_preserves_tool_search_paths() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows tool discovery");
    let mut f = Fixture::new("WIN-TOOL-ADMISSION")?;
    // The isolated profile has no toolchains. Resolve the inherited PATH, then
    // repeat with explicit tool homes, preserving credential denials both times.
    f.env.remove("CARGO_HOME");
    f.env.remove("RUSTUP_HOME");
    for explicit in [false, true] {
        let invocation = f.prepare("cmd /c echo complete");
        let policy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&invocation.arguments[1])?)?;
        let env: HashMap<String, String> = policy["request"]["process"]["env"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().split_once('=').unwrap())
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        eprintln!("admitted PATH={}", env["PATH"]);
        let node = Command::new(&env["COMSPEC"])
            .args(["/d", "/c", "node -p process.execPath"])
            .env_clear()
            .envs(&env)
            .current_dir(&f.root)
            .output()?;
        assert!(
            node.status.success(),
            "admitted Node cannot start: {node:?}"
        );
        for exe in ["cargo.exe", "rustc.exe", "node.exe"] {
            let directory = env["PATH"]
                .split(';')
                .map(PathBuf::from)
                .find(|p| p.join(exe).is_file())
                .expect("installed tool must remain on the admitted PATH");
            assert!(!directory.to_string_lossy().contains(".nodejs"));
            if exe == "node.exe" {
                assert!(
                    directory
                        .join(exe)
                        .to_string_lossy()
                        .eq_ignore_ascii_case(String::from_utf8_lossy(&node.stdout).trim()),
                    "Node PATH must name its real runtime: {node:?}"
                );
                assert!(
                    Path::new(policy["scratch"].as_str().unwrap())
                        .join("bin/npm.cmd")
                        .is_file()
                );
            }
            eprintln!(
                "tool admission explicit={explicit} executable={exe} directory={}",
                directory.display()
            );
        }
        for (command, expected) in [
            ("cargo --version", "cargo "),
            ("rustc --version", "rustc "),
            ("npm --offline --version", ""),
        ] {
            let output = Command::new(&env["COMSPEC"])
                .args(["/d", "/c", command])
                .env_clear()
                .envs(&env)
                .current_dir(&f.root)
                .output()?;
            assert!(output.status.success(), "{command}: {output:?}");
            assert!(!output.stdout.is_empty(), "{command}: {output:?}");
            assert!(
                String::from_utf8_lossy(&output.stdout).starts_with(expected),
                "{output:?}"
            );
            eprintln!(
                "admitted {command}: {}",
                String::from_utf8_lossy(&output.stdout).trim()
            );
        }
        let readonly = policy["request"]["filesystem"]["readonlyPaths"]
            .as_array()
            .unwrap();
        for key in ["CARGO_HOME", "RUSTUP_HOME"] {
            assert!(readonly.iter().any(|p| p.as_str() == Some(&env[key])));
            f.env.insert(key.into(), env[key].clone());
        }
        let cargo = Path::new(&env["CARGO_HOME"]);
        let denied = policy["request"]["filesystem"]["deniedPaths"]
            .as_array()
            .unwrap();
        for name in ["credentials", "credentials.toml"] {
            let path = cargo.join(name);
            if path.exists() {
                assert!(denied.iter().any(|p| p.as_str() == path.to_str()));
            }
        }
        let child_home = command_sandbox::mxc_policy::WinPath::new(&env["USERPROFILE"]).unwrap();
        let data =
            command_sandbox::mxc_policy::WinPath::new(f.setup.sandbox.data.to_str().unwrap())
                .unwrap();
        assert!(child_home.is_within(&data));
        command_sandbox::cleanup_prepared_invocation(&invocation)?;
    }
    f.finish();
    Ok(())
}

#[test]
fn admission_phase_profile() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows admission timing");
    let f = Fixture::new("WIN-ADMISSION-TIMING")?;
    let mut samples = Vec::new();
    for index in 0..31 {
        let start = std::time::Instant::now();
        let invocation = f.prepare("cmd /c echo complete");
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let policy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&invocation.arguments[1])?)?;
        assert!(
            policy["request"]["process"]["commandLine"]
                .as_str()
                .unwrap()
                .contains("echo complete")
        );
        assert_eq!(policy["request"]["network"]["egress"]["default"], "deny");
        assert_eq!(
            policy["request"]["filesystem"]["readwritePaths"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(
            Path::new(policy["scratch"].as_str().unwrap())
                .join("gitconfig")
                .is_file()
        );
        command_sandbox::cleanup_prepared_invocation(&invocation)?;
        if index > 0 {
            samples.push(elapsed);
        }
    }
    samples.sort_by(f64::total_cmp);
    eprintln!(
        "WINDOWS-MXC-ADMISSION samples=30 p50_ms={:.3} p95_ms={:.3} complete_policy=true",
        f64::midpoint(samples[14], samples[15]),
        samples[28]
    );
    f.finish();
    Ok(())
}
