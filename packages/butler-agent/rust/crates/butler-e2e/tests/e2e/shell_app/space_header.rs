//! The sidebar's space section header, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// The sidebar's action height (`--sidebar-action-size`) at the default density and scale: the
/// header's `min-height` in `NavSectionHeading`.
const ACTION_SIZE: f64 = 30.;

/// SHELL-APP-19 — The space section header's create trigger opens its menu, and its first row
/// (New group; the menu has no folder row) opens the create dialog. The header is as tall as the
/// sidebar action size: an anchor wrapper that adds a line box makes it taller and pushes every row
/// below it down.
#[tokio::test]
async fn shell_app_19_space_header_create_menu() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-19")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "size 1000 700",
            "wait-anchor sidebar-create-trigger",
            "layout space-header sidebar-space-header",
            "click sidebar-create-trigger",
            "wait-anchor menu-content",
            "wait-anchor sidebar-create-item-0-0",
            "click sidebar-create-item-0-0",
            "wait-anchor sidebar-dialog-input",
        ])
        .await?;
    let layout = shell.report("space-header.layout")?;
    let header = layout
        .as_array()
        .expect("layout")
        .iter()
        .find(|entry| entry["anchor"] == "sidebar-space-header")
        .unwrap_or_else(|| panic!("no space header in {layout}"));
    let height = header["h"].as_f64().expect("header height");
    assert!(
        (height - ACTION_SIZE).abs() <= 0.5,
        "the space header is {height}pt tall, expected {ACTION_SIZE}pt: {header}"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
