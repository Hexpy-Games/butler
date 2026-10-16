//! Native execution of the same bootstrap without requiring a desktop container.
use super::*;
use std::{collections::HashMap, os::windows::process::CommandExt, process::Command};

const CASES: &[(&str, i32, &str, &str)] = &[
    (
        "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; [IO.File]::ReadAllText('blocked')",
        1,
        "",
        "ConstrainedLanguage",
    ),
    ("Write-Output '한글 출력'", 0, "한글 출력\r\n", ""),
    (
        "Write-Progress -Activity 'working' -Status 'first use'; [Console]::Out.Write('complete')",
        0,
        "complete",
        "",
    ),
    (
        "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 17",
        17,
        "out",
        "err",
    ),
    ("cmd /c exit 7", 7, "", ""),
    ("cmd /c echo 한글", 0, "한글\r\n", ""),
    (
        r#"cmd /c "echo envelope & echo preserved""#,
        0,
        "envelope \r\npreserved\r\n",
        "",
    ),
    (
        r#"cmd /s /c "echo envelope & exit 19""#,
        19,
        "envelope \r\n",
        "",
    ),
    (r#"cmd /c echo "a & b""#, 0, "\"a & b\"\r\n", ""),
    (r#"cmd /c echo "| > < ^""#, 0, "\"| > < ^\"\r\n", ""),
    (
        r#"cmd /c findstr "^fn " sample.rs"#,
        0,
        "fn first() {}\r\n",
        "",
    ),
    (
        "nosuchtool; Write-Output 'continued'; cmd /c exit 0",
        0,
        "continued\r\n",
        "nosuchtool",
    ),
    (
        "& cmd /c exit 7; Write-Output $LASTEXITCODE; exit $LASTEXITCODE",
        7,
        "7\r\n",
        "",
    ),
    (
        "cmd /c echo 100% %% !literal!",
        0,
        "100% %% !literal!\r\n",
        "",
    ),
    ("& cmd /c exit 7", 1, "", ""),
    ("Write-Output 'before'; exit 23", 23, "before\r\n", ""),
    ("throw 'failure-marker'", 1, "", "failure-marker"),
    (
        "Write-Error 'error-marker' -ErrorAction Continue",
        1,
        "",
        "error-marker",
    ),
    (
        "$ExecutionContext.SessionState.LanguageMode",
        0,
        "FullLanguage\r\n",
        "",
    ),
];

pub(in crate::command_sandbox) fn verify() -> Result<(), Error> {
    let root = std::env::temp_dir().join(format!("shell-{}-한 글 %TEMP%!", std::process::id()));
    fs::create_dir_all(&root)?;
    let result = (|| {
        for (index, (script, code, stdout, stderr)) in CASES.iter().enumerate() {
            let scratch = root.join(index.to_string());
            fs::create_dir_all(scratch.join("t"))?;
            let output = run(&scratch, script)?;
            assert_eq!(output.status.code(), Some(*code), "{script}: {output:?}");
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                *stdout,
                "{script}: {output:?}"
            );
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(stderr),
                "{output:?}"
            );
            if stderr.is_empty() {
                assert!(output.stderr.is_empty(), "{output:?}");
            }
        }
        verify_semantics(&root)?;
        let scratch = root.join("long");
        fs::create_dir_all(scratch.join("t"))?;
        let output = run(&scratch, &format!("Write-Output '{}'", "한".repeat(9000)))?;
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8(output.stdout)?.trim(), "한".repeat(9000));
        eprintln!(
            "contained shell transport: complete stdout; Unicode, 9000 chars, operators, streams, exit codes"
        );
        Ok(())
    })();
    fs::remove_dir_all(&root)?;
    result
}
fn run(scratch: &Path, script: &str) -> Result<std::process::Output, Error> {
    let mut invocation = super::super::super::legacy_shell(script, false, &HashMap::new());
    super::super::super::cmd::inside_utf8_bootstrap(&mut invocation);
    fs::write(scratch.join("유니코드.txt"), "complete")?;
    fs::write(
        scratch.join("sample.rs"),
        "fn first() {}\r\nnot fn second() {}\r\n",
    )?;
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

fn verify_semantics(root: &Path) -> Result<(), Error> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let cases = [
        "nosuchtool; git status --porcelain --untracked-files=no; Write-Output $LASTEXITCODE",
        "Write-Error 'recoverable'; Write-Output 'after'",
        "& cmd /c exit 7; Write-Output $LASTEXITCODE; exit $LASTEXITCODE",
        "nosuchtool",
        "& cmd /c exit 7",
        "throw 'terminating'",
        "exit 17",
    ];
    for (index, script) in cases.iter().enumerate() {
        let scratch = root.join(format!("semantics-{index}"));
        fs::create_dir_all(scratch.join("t"))?;
        assert!(
            Command::new("git.exe")
                .args(["init", "-q"])
                .arg(&scratch)
                .status()?
                .success()
        );
        let contained = run(&scratch, script)?;
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let baseline = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-OutputFormat",
                "Text",
                "-EncodedCommand",
                &encoded,
            ])
            .current_dir(&scratch)
            .output()?;
        let invocation = super::super::super::legacy_shell(script, false, &HashMap::new());
        let mut full = Command::new(&invocation.program);
        full.current_dir(&scratch);
        super::super::super::add_arguments(&mut full, &invocation);
        let full = full.output()?;
        for output in [&contained, &full] {
            assert_eq!(
                output.status.code(),
                baseline.status.code(),
                "{script}: {output:?}; baseline={baseline:?}"
            );
            assert_eq!(
                output.stdout, baseline.stdout,
                "{script}: {output:?}; baseline={baseline:?}"
            );
        }
    }
    eprintln!(
        "PowerShell semantics: 7 direct baseline / Full Access / contained transport comparisons passed"
    );
    Ok(())
}
