//! The browser user flows against the stub-provider App sandbox.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::shell_app::{
    driver::{SERIAL, SHOTS, Shell},
    live_turns::ready_workspace,
};
use butler_e2e::e2e::{
    HarnessError, config::nonempty, fake_servers::ChatBehavior, sandbox::Sandbox,
};

#[tokio::test]
async fn browser_opens_a_page_and_navigates() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("browser_opens_a_page_and_navigates")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
        ])
        .await?;
    let blank = shell.browser_state().await?;
    assert_eq!(blank["view"], "browser");
    assert_eq!(blank["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(blank["tabs"][0]["url"], "");
    // Typing without clicking verifies that the placeholder's address is already editing.
    shell.run(&["type example.com", "key enter"]).await?;
    let first = shell.browser_state().await?;
    assert_eq!(first["tabs"][0]["url"], "https://example.com/");
    assert_eq!(first["tabs"][0]["title"], "example.com");
    assert_eq!(first["active"], first["tabs"][0]["id"]);
    shell
        .run(&["key cmd-l", "type example.org/a", "key enter"])
        .await?;
    assert_eq!(
        shell.browser_state().await?["tabs"][0]["url"],
        "https://example.org/a"
    );
    shell.run(&["click browser-back"]).await?;
    assert_eq!(
        shell.browser_state().await?["tabs"][0]["url"],
        "https://example.com/"
    );
    shell.run(&["click browser-forward"]).await?;
    assert_eq!(
        shell.browser_state().await?["tabs"][0]["url"],
        "https://example.org/a"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn browser_switches_tabs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("browser_switches_tabs")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            "type example.com",
            "key enter",
            "key cmd-t",
            "type example.org",
            "key enter",
        ])
        .await?;
    let tabs = shell.browser_state().await?;
    assert_eq!(tabs["tabs"].as_array().unwrap().len(), 2);
    assert_eq!(tabs["tabs"][0]["url"], "https://example.com/");
    assert_eq!(tabs["tabs"][1]["url"], "https://example.org/");
    shell.run(&["click browser-tab-0"]).await?;
    assert_eq!(
        shell.browser_state().await?["active"],
        tabs["tabs"][0]["id"]
    );
    shell.run(&["key cmd-w"]).await?;
    let remaining = shell.browser_state().await?;
    assert_eq!(remaining["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["active"], tabs["tabs"][1]["id"]);
    assert_eq!(remaining["tabs"][0], tabs["tabs"][1]);
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
