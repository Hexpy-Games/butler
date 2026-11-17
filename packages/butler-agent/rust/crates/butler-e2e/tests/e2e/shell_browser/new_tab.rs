//! New-tab content, history suggestions and own-tab restoration against the stub App.
use super::*;

#[tokio::test]
async fn browser_new_tab_page_lists_bookmarks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(nonempty("BUTLER_CEF_DIR").is_none(), "placeholder engine");
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("browser_new_tab_page_lists_bookmarks")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = super::super::shell_app::gateway(&shell.launch);
    let saved = gw.post("/library", serde_json::json!({"id":"bookmark", "kind":"bookmark", "title":"Saved page", "url":"https://example.org/reading", "folder":"Reading", "capturedAt":"2026-11-16T00:00:00Z"})).await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    let anchor = format!("new-tab-item-{}", saved.data()["id"].as_str().unwrap());
    shell
        .run(&[
            "browser",
            &format!("wait-anchor {anchor}"),
            &format!("click {anchor}"),
        ])
        .await?;
    let state = shell.browser_state().await?;
    assert!(
        state["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tab| tab["url"] == "https://example.org/reading" && tab["id"] == state["active"])
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn browser_address_suggestions_from_history() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(nonempty("BUTLER_CEF_DIR").is_none(), "placeholder engine");
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("browser_address_suggestions_from_history")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            "type alpha.example/first",
            "key enter",
            "key secondary-l",
            "type bravo.example/second",
            "key enter",
        ])
        .await?;
    let gw = super::super::shell_app::gateway(&shell.launch);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let page = gw.get("/browser-history?q=alpha.example%2Ffirst").await?;
        if page.data()["items"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["url"] == "https://alpha.example/first")
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "visit was not recorded: {}",
            page.text
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    shell
        .run(&[
            "key secondary-t",
            "type alph",
            "wait-anchor browser-suggestion-0-https://alpha.example/first",
            "key down",
            "key enter",
        ])
        .await?;
    let state = shell.browser_state().await?;
    let tabs = state["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 2);
    assert_eq!(tabs[1]["url"], "https://alpha.example/first");
    assert_eq!(tabs[1]["id"], state["active"]);
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn browser_tabs_restore_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(nonempty("BUTLER_CEF_DIR").is_none(), "placeholder engine");
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("browser_tabs_restore_after_restart")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            "type example.com/first",
            "key enter",
            "key secondary-t",
            "type example.org/second",
            "key enter",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
        ])
        .await?;
    let state = shell.browser_state().await?;
    let tabs = state["tabs"].as_array().unwrap();
    assert_eq!(
        tabs.iter()
            .map(|t| t["url"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["https://example.com/first", "https://example.org/second"]
    );
    assert!(tabs.iter().all(|t| t["owner"] == "mine"));
    assert_eq!(state["active"], tabs[0]["id"]);
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
