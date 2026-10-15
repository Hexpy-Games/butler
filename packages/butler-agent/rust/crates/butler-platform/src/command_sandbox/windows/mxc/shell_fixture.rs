//! Native execution of the same bootstrap without requiring a desktop container.
use super::*;
use std::{collections::HashMap, os::windows::process::CommandExt, process::Command};

pub(in crate::command_sandbox) fn verify() -> Result<(), Error> {
    let root = std::env::temp_dir().join(format!("shell-{}-한 글 %TEMP%!", std::process::id()));
    fs::create_dir_all(&root)?;
    let cases = [
        (
            "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; [IO.File]::ReadAllText('blocked')",
            1,
            "",
            "PowerShell language policy blocks this operation",
        ),
        ("Write-Output '한글 출력'", 0, "한글 출력", ""),
        (
            "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 17",
            17,
            "out",
            "err",
        ),
        ("cmd /c exit 7", 7, "", ""),
        ("cmd /c echo 100% %% !literal!", 0, "100% %% !literal!", ""),
        ("& cmd /c exit 7", 1, "", ""),
        ("Write-Output 'before'; exit 23", 23, "before", ""),
        ("throw 'failure-marker'", 1, "", "failure-marker"),
        (
            "Write-Error 'error-marker' -ErrorAction Continue",
            1,
            "",
            "error-marker",
        ),
        (
            "[IO.Path]::GetTempPath(); $ExecutionContext.SessionState.LanguageMode",
            0,
            "FullLanguage",
            "",
        ),
    ];
    let result = (|| {
        for (index, (script, code, stdout, stderr)) in cases.iter().enumerate() {
            let scratch = root.join(index.to_string());
            fs::create_dir_all(scratch.join("t"))?;
            let output = run(&scratch, script)?;
            assert_eq!(output.status.code(), Some(*code), "{script}: {output:?}");
            assert!(
                String::from_utf8_lossy(&output.stdout).contains(stdout),
                "{output:?}"
            );
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(stderr),
                "{output:?}"
            );
            if stderr.is_empty() {
                assert!(output.stderr.is_empty(), "{output:?}");
            }
        }
        let scratch = root.join("long");
        fs::create_dir_all(scratch.join("t"))?;
        let output = run(&scratch, &format!("Write-Output '{}'", "한".repeat(9000)))?;
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8(output.stdout)?.trim(), "한".repeat(9000));
        eprintln!("contained shell transport: 11 cases; Unicode, 9000 chars, streams, exit codes");
        Ok(())
    })();
    fs::remove_dir_all(&root)?;
    result
}
fn run(scratch: &Path, script: &str) -> Result<std::process::Output, Error> {
    let invocation = super::super::super::legacy_shell(script, false, &HashMap::new());
    let comspec = std::env::var("COMSPEC")?;
    let mut env = vec![format!("COMSPEC={comspec}")];
    if let Some(shell) = &invocation.shell_program {
        env.push(format!("BUTLER_COMMAND_SHELL={shell}"));
    }
    if let Some(script) = &invocation.shell_script {
        env.push(format!("BUTLER_COMMAND_SCRIPT={script}"));
    }
    let mut request =
        serde_json::json!({"process": {"commandLine": command_line(&invocation)?, "env": env}});
    let (mapping, temporary) =
        super::super::drive::Drive::temporary(scratch, scratch, &scratch.join("policy.json"))?;
    assert!(
        mapping.is_none(),
        "short physical scratch must not claim another drive"
    );
    let temporary = std::path::PathBuf::from(temporary);
    prepare(&mut request, scratch, temporary.to_str().ok_or("path")?)?;
    let line = request
        .pointer("/process/commandLine")
        .and_then(Value::as_str)
        .ok_or("line")?;
    let args = line
        .strip_prefix(&format!("\"{comspec}\" "))
        .ok_or("prefix")?;
    let mut command = Command::new(&comspec);
    command
        .raw_arg(args)
        .current_dir(scratch)
        .env("TEMP", "C:\\missing-container-temp");
    for value in request
        .pointer("/process/env")
        .and_then(Value::as_array)
        .ok_or("env")?
    {
        let (key, value) = value
            .as_str()
            .and_then(|s| s.split_once('='))
            .ok_or("entry")?;
        command.env(key, value);
    }
    let output = command.output()?;
    if script.starts_with("[IO.Path]") {
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(temporary.to_str().ok_or("path")?),
            "{output:?}"
        );
    }
    Ok(output)
}
