//! Native shell semantics and explicit bootstrap ownership.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_platform::command_sandbox::{Invocation, ShellAccess, add_arguments, login_shell};
use std::{collections::HashMap, process::Command};

#[tokio::test]
async fn cmd_scripts_expand_and_escape_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows cmd"
    );
    let mut setup = Setup::new("CMD-SEMANTICS")?;
    let mut environment =
        butler_platform::command_sandbox::tool_environment(&std::env::vars().collect());
    environment.insert("VAR".into(), "한국어 %SECOND%".into());
    environment.insert("SECOND".into(), "must remain unexpanded".into());
    for (prefix, script, expected) in [
        ("cmd /c", "echo a^&b", "a&b"),
        ("cmd /c", "echo a^|b", "a|b"),
        ("cmd /c", "echo %VAR%", "한국어 %SECOND%"),
        ("cmd /v:off /c", "echo %VAR% !VAR!", "한국어 %SECOND% !VAR!"),
        (
            "cmd /v:on /c",
            "echo %VAR% !VAR!",
            "한국어 %SECOND% 한국어 %SECOND%",
        ),
        (
            "cmd /v:on /c",
            "set VAR=changed& echo %VAR%& echo !VAR!",
            "한국어 %SECOND%\r\nchanged",
        ),
        ("cmd /c", r#"echo "한국어 & | 인수""#, "\"한국어 & | 인수\""),
        (
            "cmd /s /c",
            r#""echo 한국어& echo "quoted text"""#,
            "한국어\r\n\"quoted text\"",
        ),
    ] {
        let invocation = login_shell(
            &format!("{prefix} {script}"),
            ShellAccess::Full,
            &environment,
        )
        .unwrap();
        let cwd = setup.sandbox.home.clone();
        let env = environment.clone();
        let output = tokio::task::spawn_blocking(move || {
            let mut command = Command::new(&invocation.program);
            command.env_clear().envs(env).current_dir(cwd);
            add_arguments(&mut command, &invocation);
            command.output()
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
        assert!(output.status.success(), "{prefix}: {output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            expected,
            "{prefix} {script}"
        );
    }
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn cwd_bootstrap_is_explicit_and_independent_of_builder_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows PowerShell"
    );
    let mut setup = Setup::new("CWD-BOOTSTRAP")?;
    let environment: HashMap<_, _> =
        butler_platform::command_sandbox::tool_environment(&std::env::vars().collect());
    std::fs::write(setup.sandbox.home.join("marker.txt"), "complete contents")?;
    for arguments_first in [false, true] {
        let invocation = login_shell("Get-Content -LiteralPath marker.txt; if (Test-Path Env:BUTLER_COMMAND_RESTORE_CWD) { throw 'Bootstrap leaked' }", ShellAccess::Full, &environment).unwrap();
        let mut command = Command::new(&invocation.program);
        command.env_clear().envs(&environment);
        if arguments_first {
            add_arguments(&mut command, &invocation);
        }
        command.current_dir(&setup.sandbox.home);
        if !arguments_first {
            add_arguments(&mut command, &invocation);
        }
        let output = tokio::task::spawn_blocking(move || command.output())
            .await
            .map_err(|e| HarnessError(e.to_string()))??;
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            "complete contents"
        );
    }
    // A structured argv step with the generated shell's exact argument shape
    // must not inherit bootstrap behavior. Also exercise missing private fields
    // on a short path without changing the shipped bootstrap script.
    let paths = include_str!("../../../../butler-platform/src/command_sandbox/windows/paths.ps1")
        .replace("System.AppContextSwitches", "System.Object");
    let script = format!(
        "{paths}if (Test-Path Env:BUTLER_COMMAND_RESTORE_CWD) {{ throw 'Unexpected bootstrap' }}; Write-Output 'complete contents'"
    );
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let invocation = Invocation {
        program: "powershell.exe".into(),
        arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ]
        .map(str::to_owned)
        .to_vec(),
        restore_cwd: false,
        raw_cmd_script: false,
    };
    let mut command = Command::new(&invocation.program);
    command
        .env_clear()
        .envs(environment)
        .current_dir(&setup.sandbox.home);
    add_arguments(&mut command, &invocation);
    let output = tokio::task::spawn_blocking(move || command.output())
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "complete contents"
    );
    setup.sandbox.mark_success();
    Ok(())
}
