//! Exact shell invocations with app-like environment and verified output.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::command_sandbox::{
    Invocation, ShellAccess, add_arguments, login_shell, tool_environment, working_directory,
};
use std::{collections::HashMap, time::Instant};

const POWERSHELL_STARTUP_P50_MS: u64 = 1000;

#[tokio::test]
async fn native_shell_startup_has_complete_unicode_output() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows native shell"
    );
    let setup = Setup::new("SHELL-STARTUP")?;
    // Keep the App's PSModulePath: module discovery cost is part of startup.
    let mut environment = tool_environment(&std::env::vars().collect::<HashMap<_, _>>());
    for (name, path) in [
        ("HOME", setup.sandbox.home.clone()),
        ("USERPROFILE", setup.sandbox.home.clone()),
        ("BUTLER_DATA", setup.sandbox.data.clone()),
        ("LOCALAPPDATA", setup.sandbox.home.join("AppData/Local")),
        ("APPDATA", setup.sandbox.home.join("AppData/Roaming")),
    ] {
        std::fs::create_dir_all(&path)?;
        environment.insert(name.into(), path.display().to_string());
    }
    tokio::task::spawn_blocking(move || {
        let spaced = setup.sandbox.home.join("Directory with spaces");
        std::fs::create_dir_all(&spaced).unwrap();
        std::fs::write(spaced.join("한국어 파일.txt"), "한국어 경로 출력").unwrap();
        for prefix in ["cmd /c", "cmd.exe /d /c", "cmd /s /c"] {
            for outer_quotes in [false, true] {
                let text = r#"echo 한국어 출력& type "%USERPROFILE%\Directory with spaces\한국어 파일.txt""#;
                let text = if outer_quotes { format!("\"{text}\"") } else { text.into() };
                let invocation = login_shell(&format!("{prefix} {text}"), ShellAccess::Full, &environment).unwrap();
                let mut command = std::process::Command::new(&invocation.program);
                command.env_clear().envs(&environment).current_dir(&setup.sandbox.home);
                add_arguments(&mut command, &invocation);
                let output = command.output().unwrap();
                assert!(output.status.success(), "{prefix} outer_quotes={outer_quotes}: {output:?}");
                assert_eq!(String::from_utf8(output.stdout).unwrap(), "한국어 출력\r\n한국어 경로 출력");
            }
        }
        for (shell, script) in [
            ("cmd", "echo 안녕하세요"),
            ("powershell", "if (Test-Path Env:BUTLER_COMMAND_CWD) { throw 'Private cwd bootstrap variable leaked' }; Write-Output '안녕하세요'; [Console]::Error.WriteLine('command_shell_phase phase=command_done utc_ticks=' + [DateTime]::UtcNow.Ticks)"),
        ] {
            let invocation = if shell == "cmd" {
                Invocation {
                    program: environment.get("COMSPEC").cloned().unwrap_or("cmd.exe".into()),
                    arguments: vec!["/d".into(), "/s".into(), "/c".into(),
                        format!("chcp 65001>nul & {script}")],
                    ..Default::default()
                }
            } else {
                login_shell(script, ShellAccess::Full, &environment).unwrap()
            };
            let mut timings = Vec::new();
            for sample in 0..20 {
                let mut command = std::process::Command::new(&invocation.program);
                command.env_clear().envs(&environment).current_dir(&setup.sandbox.home);
                add_arguments(&mut command, &invocation);
                let start_utc_us = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
                let started = Instant::now();
                let output = command.output().unwrap();
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
                assert!(output.status.success(), "{shell}: {output:?}");
                assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "안녕하세요");
                eprintln!("SHELL-STARTUP shell={shell} sample={sample} start_utc_us={start_utc_us} elapsed_ms={elapsed_ms:.3}");
                for line in String::from_utf8(output.stderr).unwrap().lines()
                    .filter(|line| line.starts_with("command_shell_phase "))
                {
                    eprintln!("{line}");
                }
                timings.push(elapsed_ms);
            }
            let first = timings[0];
            timings.sort_by(f64::total_cmp);
            let p50 = f64::midpoint(timings[9], timings[10]);
            eprintln!("SHELL-STARTUP shell={shell} n=20 first_ms={first:.3} p50_ms={:.3} p95_ms={:.3} max_ms={:.3} output_verified=20", p50, timings[18], timings[19]);
            if shell == "powershell" {
                // Shipped invocation, inherited module path: a module scan per
                // command (about 22 s on hosted runners) must fail this check.
                butler_e2e::assert_wall_clock_budget!(
                    std::time::Duration::from_secs_f64(p50 / 1000.),
                    std::time::Duration::from_millis(POWERSHELL_STARTUP_P50_MS),
                    "PowerShell command startup p50",
                );
            }
        }
        let mut long_directory = spaced.join("한국어 Directory");
        for _ in 0..6 {
            long_directory.push("long-component-012345678901234567890123456789");
        }
        std::fs::create_dir_all(&long_directory).unwrap();
        std::fs::write(long_directory.parent().unwrap().join("parent marker.txt"), "parent marker").unwrap();
        let script = r"try {
            if ((Get-Content -LiteralPath '..\parent marker.txt' -Raw -ErrorAction Stop) -cne 'parent marker') { throw 'Parent directory changed' }
            echo exact-output > plain.txt
            if ((Get-Content -LiteralPath 'plain.txt' -Raw -ErrorAction Stop).TrimEnd() -cne 'exact-output') { throw 'Plain redirection changed' }
            Remove-Item -LiteralPath 'plain.txt' -ErrorAction Stop
            echo '한국어 내용' > 'unicode marker.txt'
            Rename-Item -LiteralPath 'unicode marker.txt' -NewName 'renamed marker.txt' -ErrorAction Stop
            $content = Get-Content -LiteralPath 'renamed marker.txt' -Raw -ErrorAction Stop
            if ([IO.File]::ReadAllText('renamed marker.txt') -cne $content) { throw 'Process directory changed' }
            Remove-Item -LiteralPath 'renamed marker.txt' -ErrorAction Stop
            [Console]::Write($content)
        } catch {
            [Console]::Error.WriteLine('probe_location=' + (Get-Location).ProviderPath)
            [Console]::Error.WriteLine('probe_parent=' + $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('..\parent marker.txt'))
            [Console]::Error.WriteLine($_.Exception.ToString())
            throw
        }";
        let invocation = login_shell(script, ShellAccess::Full, &environment).unwrap();
        let mut command = std::process::Command::new(&invocation.program);
        command.env_clear().envs(&environment).current_dir(working_directory(&long_directory).unwrap());
        add_arguments(&mut command, &invocation);
        let output = command.output().unwrap();
        assert!(output.status.success(), "long-directory PowerShell: {output:?}");
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "한국어 내용\r\n");
        assert!(!long_directory.join("unicode marker.txt").exists());
        assert!(!long_directory.join("renamed marker.txt").exists());
        assert!(!long_directory.join("plain.txt").exists());
    }).await.map_err(|error| HarnessError(error.to_string()))?;
    Ok(())
}

/// One unit past the longest folder a Windows process starts in (258).
#[test]
fn working_directory_of_259_units_starts_a_process() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows working-directory limit"
    );
    let setup = Setup::new("CWD-259")?;
    let units = |path: &std::path::Path| path.as_os_str().to_string_lossy().encode_utf16().count();
    let mut directory = setup.sandbox.root.clone();
    // Components longer than 8.3 names, so the folder has a shorter alias.
    let component = "long-component-0123456789012345678901234";
    while units(&directory) + 2 * (component.len() + 1) <= 259 {
        directory.push(component);
    }
    let rest = 258 - units(&directory);
    assert!(rest > 12, "sandbox root too long: {}", directory.display());
    directory.push("x".repeat(rest));
    assert_eq!(units(&directory), 259, "{}", directory.display());
    std::fs::create_dir_all(&directory)?;
    let status = std::process::Command::new("cmd")
        .args(["/d", "/c", "exit 0"])
        .current_dir(working_directory(&directory)?)
        .status()?;
    assert!(status.success(), "{status:?}");
    Ok(())
}

#[test]
fn shell_phase_timings_require_invocation_opt_in() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows shell diagnostics"
    );
    let setup = Setup::new("SHELL-TIMING-OUTPUT")?;
    for value in [None, Some(None), Some(Some("0")), Some(Some("1"))] {
        let mut environment = HashMap::new();
        if let Some(value) = value {
            environment.insert(
                "BUTLER_DEBUG_COMMAND_TIMINGS".into(),
                value.map(str::to_owned),
            );
        }
        let invocation = butler_platform::command_sandbox::legacy_shell(
            "Write-Output '한글 출력'; [Console]::Error.Write('command-error'); exit 17",
            false,
            &environment,
        );
        let mut command = std::process::Command::new(&invocation.program);
        command.current_dir(&setup.sandbox.home);
        // Also exercise ambient diagnostics in the child, independently of the
        // invocation map. CI enables the same flag in this test's parent.
        command.env("BUTLER_DEBUG_COMMAND_TIMINGS", "1");
        add_arguments(&mut command, &invocation);
        let output = command.output()?;
        assert_eq!(output.status.code(), Some(17), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).expect("UTF-8 stdout"),
            "한글 출력\r\n"
        );
        let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
        if value == Some(Some("1")) {
            let lines = stderr.lines().collect::<Vec<_>>();
            assert_eq!(lines.len(), 3, "{stderr}");
            for (line, phase) in lines.iter().zip(["script_started", "modules_ready"]) {
                let prefix = format!("command_shell_phase phase={phase} utc_ticks=");
                let ticks = line.strip_prefix(&prefix).expect("phase diagnostic");
                assert!(ticks.parse::<u64>().expect("UTC ticks") > 0);
            }
            assert_eq!(lines[2], "command-error");
        } else {
            assert_eq!(stderr, "command-error");
        }
    }
    Ok(())
}
