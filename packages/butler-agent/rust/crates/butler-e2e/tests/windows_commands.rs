//! Native command-tool regression: sanitized Windows environment, quotes,
//! Unicode output, ordinary Downloads observation and Ledger protection.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason="test assertions")]
mod windows_commands { pub(super) mod stub; }
use windows_commands::stub;
use butler_e2e::e2e::{HarnessError, gateway::{tool_rows,turn_state}, scenario::Setup};
use serde_json::Value;

async fn run(case: &str, command: &str) -> Result<Value,HarnessError> {
    let setup=Setup::new(case)?.stub_cassette(stub::cassette(command)?);
    let downloads=setup.sandbox.home.join("Downloads");
    std::fs::create_dir_all(&downloads)?;
    std::fs::write(downloads.join("보고서.txt"),"document")?;
    std::fs::write(downloads.join("사진.png"),"image")?;
    let home=setup.sandbox.home.display().to_string();
    let setup=setup.env("USERPROFILE",home);
    let s=setup.start().await?;
    let (id,turn)=s.turn("general",stub::PROMPT).await?;
    assert_eq!(turn_state(&turn),"delivered","{turn}");
    let messages=s.gw.messages("general").await?;
    let rows=tool_rows(&messages,&id);
    let row=rows.iter().find(|r| r["safe_tool_name"]=="run_command").expect("command tool row");
    let text=s.gw.operation_output(&id,row).await?;
    let output:Value=serde_json::from_str(&text)?;
    eprintln!("{case}: {output}");
    assert_eq!(std::fs::read_to_string(downloads.join("보고서.txt"))?,"document");
    assert_eq!(std::fs::read_to_string(downloads.join("사진.png"))?,"image");
    assert!(messages.iter().any(|m| m["role"]=="assistant" && m["text"]==stub::ANSWER));
    assert_eq!(s.provider()?.served(),2);
    s.finish().await?;
    Ok(output)
}

fn successful(output: &Value, expected: &str) {
    assert_eq!(output["exit_code"],0,"{output}");
    let text=output["stdout"].as_str().unwrap_or_default();
    assert!(text.contains(expected),"{output}");
    assert!(!text.contains('\u{fffd}') && !text.contains('\0'),"{output}");
}

#[tokio::test]
async fn windows_command_tool_native_matrix() -> Result<(),HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!butler_platform::command_sandbox::POSIX_SHELL,"Windows native commands");
    for (case,command,expected) in [
        ("WIN-POWERSHELL",r#"powershell.exe -NoProfile -Command "Write-Output '안녕하세요'""#,"안녕하세요"),
        ("WIN-REG",r#"reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders""#,"HKEY_CURRENT_USER"),
        ("WIN-CMD",r#"cmd /c dir "$env:USERPROFILE\Downloads""#,"보고서.txt"),
        ("WIN-NODE",r#"node -e "console.log('안녕하세요')""#,"안녕하세요"),
        ("WIN-PYTHON",r#"python -B -c "import os; print('안녕하세요'); print(hex(0 & 0xffffffff)); print(os.listdir(os.path.join(os.environ['USERPROFILE'],'Downloads')))""#,"보고서.txt"),
        ("WIN-DOWNLOADS",r#"Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" | Sort-Object Name | Select-Object -ExpandProperty Name"#,"사진.png"),
    ] {
        if case=="WIN-PYTHON" && std::process::Command::new("python").arg("--version").output().is_err() {
            eprintln!("WIN-PYTHON skipped: python interpreter is not installed"); continue;
        }
        successful(&run(case,command).await?,expected);
    }
    Ok(())
}

#[tokio::test]
async fn quoted_bitwise_and_is_not_a_background_ledger_write() -> Result<(),HarnessError> {
    butler_e2e::gate!();
    let command=if butler_platform::command_sandbox::POSIX_SHELL {
        r#"python3 -B -c "print(hex(0 & 0xffffffff))""#
    } else { r#"python -B -c "print(hex(0 & 0xffffffff))""# };
    successful(&run("QUOTED-AND",command).await?,"0x0");
    Ok(())
}

#[tokio::test]
async fn command_tool_still_refuses_ledger_writes() -> Result<(),HarnessError> {
    butler_e2e::gate!();
    let output=run("LEDGER-GUARD","echo changed > .project-ledger/records.json").await?;
    assert_eq!(output["error"],"protected_path","{output}");
    assert_eq!(output["exit_code"],1,"{output}");
    Ok(())
}
