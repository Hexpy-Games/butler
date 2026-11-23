use super::*;

async fn pick_page() -> Result<(String, tokio_util::task::AbortOnDropHandle<()>), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/pick", axum::routing::get(|| async {
        axum::response::Html("<title>pick</title><body style='margin:0'><button style='display:block;margin:40px;width:200px;height:100px'>Pick me</button></body>")
    }));
    let server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    Ok((format!("http://{address}/pick"), server))
}

async fn until(
    shell: &mut Shell,
    what: &str,
    done: impl Fn(&serde_json::Value) -> bool,
) -> Result<serde_json::Value, HarnessError> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let state = shell.browser_state().await?;
        if done(&state) {
            return Ok(state);
        }
        assert!(tokio::time::Instant::now() < deadline, "{what}: {state}");
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn cef_picks_an_element() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_picks_an_element")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let (url, _server) = pick_page().await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            "key secondary-l",
            &format!("type {url}"),
            "key enter",
        ])
        .await?;
    wait_for_page(&mut shell, "pick", &url).await?;
    shell
        .run(&["key secondary-shift-s", "wait-anchor browser-pick-band"])
        .await?;
    assert_eq!(shell.browser_state().await?["tabs"][0]["picking"], true);
    shell
        .run(&["page-hover 140 90", "wait-anchor browser-pick-hover"])
        .await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let state = shell.browser_state().await?;
        if state["tabs"][0]["pick_hover"]
            .as_str()
            .is_some_and(|s| s.starts_with("button · 200 × 100"))
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "button hover missing: {state}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    shell.run(&["page-click 140 90"]).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let state = shell.browser_state().await?;
        if state["tabs"][0]["selection_count"] == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "element was not picked: {state}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    shell.run(&["key escape"]).await?;
    let state = shell.browser_state().await?;
    assert_eq!(state["tabs"][0]["picking"], false);
    assert_eq!(state["tabs"][0]["selection_count"], 1);
    let next = format!("{url}?2");
    shell
        .run(&["key secondary-l", &format!("type {next}"), "key enter"])
        .await?;
    wait_for_page(&mut shell, "pick", &next).await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let state = shell.browser_state().await?;
        if state["tabs"][0]["selection_count"] == 0 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "navigation kept picks: {state}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn cef_picks_and_attaches() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_picks_and_attaches")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let (url, _server) = pick_page().await?;
    let site = url
        .trim_start_matches("http://")
        .trim_end_matches("/pick")
        .to_owned();
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            "key secondary-l",
            &format!("type {url}"),
            "key enter",
        ])
        .await?;
    wait_for_page(&mut shell, "pick", &url).await?;
    shell
        .run(&[
            "key secondary-shift-s",
            "wait-anchor browser-selection-bar",
            "page-click 140 90",
        ])
        .await?;
    until(&mut shell, "button picked", |s| {
        s["tabs"][0]["selection_count"] == 1
    })
    .await?;
    shell.run(&["pick-attach"]).await?;
    let state = until(&mut shell, "one element attachment", |s| {
        s["composer_elements"]
            .as_array()
            .is_some_and(|e| e.len() == 1)
    })
    .await?;
    assert_eq!(state["composer_elements"][0]["title"], "Pick me");
    assert_eq!(state["composer_elements"][0]["site"], site.as_str());
    assert!(
        state["composer_elements"][0]["image"]
            .as_u64()
            .is_some_and(|n| n > 0)
    );
    shell
        .run(&["close", "wait-anchor composer-elements"])
        .await?;
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
