//! Exact shell invocations with app-like environment and verified output.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::command_sandbox::{
    Invocation, ShellAccess, add_arguments, login_shell, tool_environment, working_directory,
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
    let inherited_module_path = environment.remove("PSModulePath");
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
            ("powershell", "if (Test-Path Env:BUTLER_COMMAND_RESTORE_CWD) { throw 'Private cwd bootstrap variable leaked' }; Write-Output '안녕하세요'; [Console]::Error.WriteLine('command_shell_phase phase=command_done utc_ticks=' + [DateTime]::UtcNow.Ticks)"),
        ] {
            let invocation = if shell == "cmd" {
                Invocation {
                    restore_cwd: false,
                    raw_cmd_script: true,
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
        if let Some(path) = inherited_module_path {
            environment.insert("PSModulePath".into(), path);
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
