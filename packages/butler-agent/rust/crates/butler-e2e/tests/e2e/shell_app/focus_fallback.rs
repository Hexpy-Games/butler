//! Keyboard focus when the focused element goes, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-07 — When the focused page goes (History's search field, then a chat opens from
/// the sidebar), the shell root takes focus, as Electron's `body` does: mod+K still opens the
/// command palette.
#[tokio::test]
async fn shell_app_07_shortcuts_work_after_the_focused_page_goes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-07")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Focus"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let row = format!("sidebar-row-{id}");
    shell
        .run(&[
            &format!("wait-anchor {row}"),
            "history",
            "wait-anchor history-search",
            "click history-search",
            &format!("click {row}"),
            "wait-no-anchor history-page",
            "key secondary-k",
            "expect-palette",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
