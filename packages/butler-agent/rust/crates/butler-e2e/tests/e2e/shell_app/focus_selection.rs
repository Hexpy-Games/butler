//! Focus moved onto a text field by Tab or by script selects its text, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-17 — Focus that moves onto a text field selects the field's text, as a browser
/// does: the address field takes focus with the URL selected; the rename dialog opens with the
/// title selected, and Tab past either end of the dialog wraps back onto the field with its text
/// selected. Copy shows what is selected (it copies nothing without a selection).
#[tokio::test]
async fn shell_app_17_focus_selects_field_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_none(),
        "runs on the placeholder engine"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-17")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Rename me"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            "browser",
            "wait-anchor browser-area",
            "type example.com",
            "key enter",
        ])
        .await?;
    let url = shell.browser_state().await?["tabs"][0]["url"].clone();
    shell
        .run(&[
            "click browser-address",
            "key secondary-c",
            &format!("expect-clipboard {url}"),
            &format!("open {id}"),
            "click session-menu-trigger",
            "wait-anchor session-menu-item-0-0",
            "click session-menu-item-0-0",
            "wait-anchor dialog-content",
            "key secondary-c",
            "expect-clipboard \"Rename me\"",
            "type Renamed",
            "key shift-tab",
            "key tab",
            "key secondary-c",
            "expect-clipboard \"Renamed\"",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
