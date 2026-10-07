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
        "Set-Content -NoNewline -LiteralPath approved-command.txt -Value approved"
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
    assert!(s.gw.approval_requests(&chat).await?.is_empty());
    s.finish().await?;
    server.abort();
    Ok(())
}
