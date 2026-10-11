//! Exact shell invocations with app-like environment and verified output.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::command_sandbox::{
    Invocation, ShellAccess, add_arguments, login_shell, tool_environment,
};
use std::{collections::HashMap, time::Instant};

#[tokio::test]
async fn native_shell_startup_has_complete_unicode_output() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows native shell"
    );
    let setup = Setup::new("SHELL-STARTUP")?;
    let mut environment = tool_environment(&std::env::vars().collect::<HashMap<_, _>>());
    environment.remove("PSModulePath");
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
            eprintln!("SHELL-STARTUP shell={shell} n=20 first_ms={first:.3} p50_ms={:.3} p95_ms={:.3} max_ms={:.3} output_verified=20", timings[9], timings[18], timings[19]);
        }
    }).await.map_err(|error| HarnessError(error.to_string()))?;
    Ok(())
}
