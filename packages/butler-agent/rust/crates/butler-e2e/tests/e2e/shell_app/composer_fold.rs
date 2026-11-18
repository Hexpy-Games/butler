//! The composer card's fold motion through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-13 — The composer folds with motion: in a new chat the engaged composer is unfolded;
/// a real click elsewhere folds it, and the card's height passes through values between open and
/// folded over the exit motion instead of jumping, as Electron's CSS height transition does (the
/// card's glass follows a layout height).
#[tokio::test]
async fn shell_app_13_composer_folds_with_motion() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-13")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "new",
            "compose",
            "expect-composer-focus",
            "expect-click-glide titlebar composer",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
