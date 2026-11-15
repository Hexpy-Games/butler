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
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_none(),
        "runs on the placeholder engine"
    );
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
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_none(),
        "runs on the placeholder engine"
    );
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

#[tokio::test]
async fn conversation_link_opens_in_its_browser() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_none(),
        "runs on the placeholder engine"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("conversation_link_opens_in_its_browser")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = super::shell_app::gateway(&shell.launch);
    let created = gw
        .post(
            "/sessions",
            serde_json::json!({"kind": "chat", "title": "Browser link"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let sent = gw.post("/messages", serde_json::json!({"chat_id": id, "text": "Hello", "client_message_id": "browser-link"})).await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
            "expect-no-anchor titlebar-file-viewer-toggle",
            "browser-link https://example.com/",
            "wait-anchor browser-area",
            "expect-no-anchor titlebar-file-viewer-toggle",
        ])
        .await?;
    let state = shell.browser_state().await?;
    assert_eq!(state["view"], "session");
    assert_eq!(state["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(state["tabs"][0]["owner"], format!("conversation:{id}"));
    assert_eq!(state["tabs"][0]["url"], "https://example.com/");
    assert_eq!(state["active"], state["tabs"][0]["id"]);
    shell
        .run(&[
            "click titlebar-browser-toggle",
            "wait-no-anchor browser-area",
            "expect-no-anchor titlebar-file-viewer-toggle",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn cef_renders_a_local_page() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_renders_a_local_page")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new()
        .route("/first", axum::routing::get(|| async {
            axum::response::Html("<title>First local page</title><body style='margin:0;background:#14508c'>First local page</body>")
        }))
        .route("/second", axum::routing::get(|| async {
            axum::response::Html("<title>Second local page</title><body style='margin:0;background:#8c5014'>Second local page</body>")
        }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let first = format!("http://{address}/first");
    let second = format!("http://{address}/second");
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
        ])
        .await?;
    for (url, title, back) in [
        (&first, "First local page", false),
        (&second, "Second local page", false),
        (&first, "First local page", true),
    ] {
        if back {
            shell.run(&["click browser-back"]).await?;
        } else {
            shell
                .run(&["key cmd-l", &format!("type {url}"), "key enter"])
                .await?;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let state = shell.browser_state().await?;
            if state["tabs"][0]["title"] == title
                && state["tabs"][0]["url"] == *url
                && state["tabs"][0]["status"] == "idle"
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "page did not finish: {state}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let frame = shell.browser_frame().await?;
        if let Some(actual) = frame["frame"].as_array() {
            let scale = frame["scale"].as_f64().unwrap();
            assert_eq!(actual.len(), 2);
            for (axis, dimension) in actual.iter().enumerate() {
                assert!(dimension.as_u64().unwrap() > 0);
                assert_eq!(
                    dimension.as_f64().unwrap(),
                    (frame["content"][axis].as_f64().unwrap() * scale).round()
                );
            }
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "CEF did not produce a frame: {frame}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    shell.run(&["shot cef-browser", "app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
