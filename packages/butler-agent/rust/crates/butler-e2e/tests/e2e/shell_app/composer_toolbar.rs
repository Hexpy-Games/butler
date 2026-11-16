//! The composer's toolbar controls, used with a real pointer, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-08 — With the composer unfolded, a press on a toolbar control (the "+", the access
/// menu, the model menu) opens its menu and the card stays unfolded, as in Electron, where focus
/// moving between the card's controls does not fold it (`useComposerPresentation`).
#[tokio::test]
async fn shell_app_08_toolbar_menus_open_from_the_unfolded_composer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-08")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "controls loaded",
            "new",
            "compose",
        ])
        .await?;
    for menu in ["attachment-menu", "access-menu", "model-menu"] {
        shell
            .run(&[
                &format!("wait-anchor {menu}"),
                &format!("click {menu}"),
                "expect-composer-menu open",
                // The same press closes it; the card is still unfolded for the next control.
                &format!("click {menu}"),
                "expect-composer-menu closed",
                &format!("expect-anchor {menu}"),
            ])
            .await?;
    }
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
