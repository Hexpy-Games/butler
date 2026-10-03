//! Native command-tool regression: sanitized Windows environment, quotes,
//! Unicode output, ordinary Downloads observation and Ledger protection.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "windows_commands/stub.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    scenario::Setup,
};
use serde_json::Value;

async fn run(case: &str, command: &str) -> Result<Value, HarnessError> {
    let mut setup = Setup::new(case)?
        .stub_cassette(stub::cassette(command)?)
        .env("BUTLER_E2E_CANARY", "must-not-reach-command");
    installed_bundle(&mut setup);
    let downloads = setup.sandbox.home.join("Downloads");
    std::fs::create_dir_all(&downloads)?;
    std::fs::write(downloads.join("보고서.txt"), "document")?;
    std::fs::write(downloads.join("사진.png"), "image")?;
    let home = setup.sandbox.home.display().to_string();
    let local = setup.sandbox.home.join("AppData/Local");
    let roaming = setup.sandbox.home.join("AppData/Roaming");
    std::fs::create_dir_all(&local)?;
    std::fs::create_dir_all(&roaming)?;
    let setup = setup
        .env("USERPROFILE", home)
        .env("LOCALAPPDATA", local.display().to_string())
        .env("APPDATA", roaming.display().to_string());
    let s = setup.start().await?;
    let (id, turn) = s.turn("general", stub::PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let messages = s.gw.messages("general").await?;
    let rows = tool_rows(&messages, &id);
    let row = rows
        .iter()
        .find(|r| r["safe_tool_name"] == "run_command")
        .expect("command tool row");
    assert!(
        matches!(row["state"].as_str(), Some("delivered" | "failed")),
        "{row}"
    );
    let requests = s.provider()?.requests();
    let text = requests
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output")
        .expect("model receives command result")["output"]
        .as_str()
        .expect("command result JSON");
    let result: Value = serde_json::from_str(text)?;
    let output = result
        .get("output")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(result);
    eprintln!("{case}: {output}");
    assert_eq!(
        std::fs::read_to_string(downloads.join("보고서.txt"))?,
        "document"
    );
    assert_eq!(
        std::fs::read_to_string(downloads.join("사진.png"))?,
        "image"
    );
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == stub::ANSWER)
    );
    assert_eq!(std::fs::read_dir(&downloads)?.count(), 2);
    if case == "WIN-DOWNLOADS" && output["exit_code"] == 0 {
        let stdout = output["stdout"].as_str().unwrap_or_default();
        assert_eq!(
            stdout.lines().map(str::trim).collect::<Vec<_>>(),
            vec!["보고서.txt", "사진.png"]
        );
        let requests = s.provider()?.requests();
        assert!(requests.last().unwrap().to_string().contains("보고서.txt"));
        assert!(requests.last().unwrap().to_string().contains("사진.png"));
    }
    assert_eq!(s.provider()?.served(), 2);
    s.finish().await?;
    Ok(output)
}

fn installed_bundle(setup: &mut Setup) {
    if let Some(root) = std::env::var_os("BUTLER_E2E_APP_PAYLOAD") {
        let root = std::path::PathBuf::from(root);
        setup.sandbox.binary = root.join("bin/butler-agent.exe");
        setup.sandbox.resources = root.join("resources");
        setup.sandbox.install = root;
    }
}

fn successful(output: &Value, expected: &str) {
    assert_eq!(output["exit_code"], 0, "{output}");
    let text = output["stdout"].as_str().unwrap_or_default();
    assert!(text.contains(expected), "{output}");
    assert!(
        !text.contains('\u{fffd}') && !text.contains('\0'),
        "{output}"
    );
}

#[tokio::test]
async fn windows_command_tool_native_matrix() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows native commands"
    );
    let system_root = std::env::var("SystemRoot").unwrap_or_default();
    let mut outputs = Vec::new();
    for (case, command, expected) in [
        (
            "WIN-POWERSHELL",
            r#"powershell.exe -NoProfile -Command "Write-Output '안녕하세요'""#,
            "안녕하세요",
        ),
        (
            "WIN-PS-VARS",
            r#"powershell.exe -NoProfile -Command "$key=Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'; $key.Name""#,
            "HKEY_CURRENT_USER",
        ),
        (
            "WIN-REG",
            r#"reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders""#,
            "HKEY_CURRENT_USER",
        ),
        (
            "WIN-CMD",
            r#"cmd /c dir "%USERPROFILE%\Downloads""#,
            "보고서.txt",
        ),
        (
            "WIN-NODE",
            r#"node -e "console.log('안녕하세요'); console.log(require('fs').readdirSync(process.env.USERPROFILE+'/Downloads'))""#,
            "안녕하세요",
        ),
        (
            "WIN-PYTHON",
            r#"python -B -c "import os; print('안녕하세요'); print(hex(0 & 0xffffffff)); print(os.listdir(os.path.join(os.environ['USERPROFILE'],'Downloads')))""#,
            "보고서.txt",
        ),
        (
            "WIN-DOWNLOADS",
            r#"Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" | Sort-Object Name | Select-Object -ExpandProperty Name"#,
            "사진.png",
        ),
        (
            "WIN-UTF16",
            r"$b=[Text.Encoding]::Unicode.GetBytes('Windows PowerShell 안녕하세요 😀'); [Console]::OpenStandardOutput().Write($b,0,$b.Length)",
            "안녕하세요 😀",
        ),
        (
            "WIN-UTF16-BE-SPLIT",
            r"$b=[Text.Encoding]::BigEndianUnicode.GetPreamble()+[Text.Encoding]::BigEndianUnicode.GetBytes('Windows PowerShell 안녕하세요 😀'); $s=[Console]::OpenStandardOutput(); foreach ($byte in $b) { $s.WriteByte($byte); $s.Flush(); Start-Sleep -Milliseconds 1 }",
            "안녕하세요 😀",
        ),
        (
            "WIN-ENV",
            r"if (Test-Path Env:BUTLER_E2E_CANARY) { throw 'Host variable leaked' }; $env:SystemRoot",
            system_root.as_str(),
        ),
    ] {
        if case == "WIN-PYTHON"
            && std::process::Command::new("python")
                .arg("--version")
                .output()
                .is_err()
        {
            eprintln!("WIN-PYTHON skipped: python interpreter is not installed");
            continue;
        }
        outputs.push((run(case, command).await?, expected));
    }
    for (output, expected) in outputs {
        successful(&output, expected);
    }
    Ok(())
}

#[tokio::test]
async fn quoted_bitwise_and_is_not_a_background_ledger_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        r#"python3 -B -c "print(hex(0 & 0xffffffff))""#
    } else {
        r#"python -B -c "print(hex(0 & 0xffffffff))""#
    };
    successful(&run("QUOTED-AND", command).await?, "0x0");
    Ok(())
}

#[tokio::test]
async fn command_tool_still_refuses_ledger_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let output = run(
        "LEDGER-GUARD",
        "echo changed > .project-ledger/records.json",
    )
    .await?;
    assert_eq!(output["error"], "protected_path", "{output}");
    assert_eq!(output["exit_code"], 1, "{output}");
    Ok(())
}

#[tokio::test]
async fn windows_ledger_case_alias_is_still_protected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows case aliases"
    );
    let output = run(
        "LEDGER-CASE",
        r"echo changed > .PROJECT-LEDGER\records.json",
    )
    .await?;
    assert_eq!(output["error"], "protected_path", "{output}");
    Ok(())
}
