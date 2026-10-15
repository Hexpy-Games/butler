//! Portable exact-command approval/resume through the capability provider.
use super::*;

#[tokio::test]
async fn command_approval_resumes_the_exact_operation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, chat, script, server) = setup(Access::AskAlways).await?;
    for (index, case) in cases(&s.sandbox.data).iter().take(4).enumerate() {
        let (output, _) = operation(&s, &chat, &script, case, Access::AskAlways).await?;
        verify(&s, index, &output)?;
    }
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        "printf approved > approved-command.txt"
    } else {
        r#"powershell.exe -NoProfile -NonInteractive -Command "Set-Content -NoNewline -LiteralPath 'approved-command.txt' -Value 'approved'""#
    };
    let case = Case {
        tool: "run_command",
        args: json!({"command":command,"state_effect":"mutation","summary":"Write marker",
            "cwd":"home/Downloads","output_mode":"full"}),
        refused: false,
    };
    operation(&s, &chat, &script, &case, Access::AskAlways).await?;
    assert_eq!(
        std::fs::read_to_string(s.sandbox.home.join("Downloads/approved-command.txt"))?,
        "approved"
    );
    assert_eq!(
        s.gw.approval_requests(&chat).await?,
        [] as [serde_json::Value; 0]
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn powershell_rename_unicode_path_needs_one_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows native shell"
    );
    let (s, chat, script, server) = setup(Access::AskAlways).await?;
    let downloads = s.sandbox.home.join("Downloads");
    let command = "Rename-Item -LiteralPath '보고서.txt' -NewName '이름 바꾼 파일.txt'";
    let case = Case {
        tool: "run_command",
        args: json!({"command":command,"state_effect":"mutation","summary":"파일 이름 변경",
            "cwd":"home/Downloads","output_mode":"full"}),
        refused: false,
    };
    let (output, _) = operation(&s, &chat, &script, &case, Access::AskAlways).await?;
    assert_eq!(output["exit_code"], 0, "{output}");
    assert_eq!(output["timed_out"], false, "{output}");
    assert!(!downloads.join("보고서.txt").exists());
    assert_eq!(
        std::fs::read_to_string(downloads.join("이름 바꾼 파일.txt"))?,
        "기존 내용"
    );
    assert_eq!(
        s.gw.approval_requests(&chat).await?,
        [] as [serde_json::Value; 0]
    );
    // One emitted operation and one successful result; the provider never retries.
    assert_eq!(output["command"], command);
    let listing = Case {
        tool: "run_command",
        args: json!({"command":"dir -Name | Sort-Object","state_effect":"read_only",
            "summary":"파일 목록 확인","cwd":"home/Downloads","output_mode":"full"}),
        refused: false,
    };
    let (output, _) = operation(&s, &chat, &script, &listing, Access::AskAlways).await?;
    assert_eq!(
        output["stdout"]
            .as_str()
            .unwrap()
            .lines()
            .map(str::trim)
            .collect::<Vec<_>>(),
        vec!["이름 바꾼 파일.txt", "정리"]
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn approved_powershell_mutation_keeps_ledger_protected() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !butler_platform::command_sandbox::POSIX_SHELL,
        "Windows native shell"
    );
    let (s, chat, script, server) = setup(Access::AskAlways).await?;
    let ledger = s.sandbox.root.join(".project-ledger");
    std::fs::create_dir_all(&ledger)?;
    std::fs::write(ledger.join("records.json"), "unchanged")?;
    for command in [
        "Set-Content -LiteralPath '.PROJECT-LEDGER/records.json' -Value changed",
        "copy home/Downloads/보고서.txt .PROJECT-LEDGER/records.json",
        "ren .PROJECT-LEDGER/records.json changed.json",
    ] {
        let case = Case {
            tool: "run_command",
            args: json!({"command":command,"state_effect":"mutation","summary":"기록 변경",
                "cwd":".","output_mode":"full"}),
            refused: true,
        };
        operation(&s, &chat, &script, &case, Access::AskAlways).await?;
        assert_eq!(
            std::fs::read_to_string(ledger.join("records.json"))?,
            "unchanged"
        );
        assert_eq!(std::fs::read_dir(&ledger)?.count(), 1);
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

pub(super) async fn assert_single_operation(
    s: &Scenario,
    chat: &str,
    id: &str,
) -> Result<(), HarnessError> {
    let messages = s.gw.messages(chat).await?;
    assert_eq!(
        butler_e2e::e2e::gateway::tool_rows(&messages, id)
            .iter()
            .filter(|row| row["safe_tool_name"] == "run_command")
            .count(),
        1,
        "one command operation, no fallback"
    );
    Ok(())
}
