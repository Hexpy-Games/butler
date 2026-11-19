//! Text size through the native shell's keyboard shortcuts.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-06 — Text size: the shortcut zooms the whole window and saves the setting, reset returns to 1, a press on an Appearance size option sets and saves it, and a size saved through the Agent reaches the open window.
#[tokio::test]
async fn shell_app_06_text_size_zooms_the_window() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-06")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    shell.run(&["key secondary-=", "expect-scale 1.15"]).await?;
    let gw = gateway(&shell.launch);
    let saved_as = |expected: &'static str| {
        let gw = gw.clone();
        async move {
            let mut saved = gw.settings().await?["text_size"].clone();
            for _ in 0..50 {
                if saved == expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                saved = gw.settings().await?["text_size"].clone();
            }
            assert_eq!(saved, expected);
            Ok::<(), HarnessError>(())
        }
    };
    saved_as("large").await?;
    shell.run(&["key secondary-0", "expect-scale 1"]).await?;
    saved_as("default").await?;
    // In Settings > Appearance, at the large size, a pointer press on the first option of the
    // text-size group (기본) sets the default again. The group starts at the anchor's left edge
    // whether its column stretches the anchor or not, so 4% of its width lands in that option.
    shell
        .run(&[
            "click sidebar-settings",
            "wait-anchor settings-nav-appearance",
            "click settings-nav-appearance",
            "wait-anchor text-size",
            "key secondary-=",
            "expect-scale 1.15",
            "click-at text-size 0.04 0.5",
            "expect-scale 1",
        ])
        .await?;
    saved_as("default").await?;
    let patched = gw
        .patch("/settings", json!({"text_size": "larger"}))
        .await?;
    assert_eq!(patched.status, 200, "{}", patched.text);
    shell.run(&["expect-scale 1.3"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
