//! CEF user popups and page dialogs against local pages, with the stub provider.
#![allow(clippy::unwrap_used, clippy::panic, reason = "E2E assertions")]
use super::shell_app::{
    driver::{SERIAL, SHOTS, Shell},
    live_turns::ready_workspace,
};
use butler_e2e::e2e::{
    HarnessError, config::nonempty, fake_servers::ChatBehavior, sandbox::Sandbox,
};
use std::time::Duration;

#[tokio::test]
async fn cef_target_blank_opens_a_tab() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_target_blank_opens_a_tab")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/", axum::routing::get(|| async {
        axum::response::Html("<title>Ready</title><body style='margin:0'><a style='display:block;width:150px;height:40px' target='_blank' href='/child'>Open</a></body>")
    })).route("/child", axum::routing::get(|| async { axum::response::Html("<title>Child</title>") }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            &format!("type http://{address}/"),
            "key enter",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while shell.browser_state().await?["tabs"][0]["title"] != "Ready" {
        assert!(
            tokio::time::Instant::now() < deadline,
            "opener did not load"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell.run(&["page-click 20 20"]).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let state = shell.browser_state().await?;
        if state["tabs"].as_array().unwrap().len() == 2 && state["tabs"][1]["title"] == "Child" {
            assert_eq!(state["tabs"][1]["url"], format!("http://{address}/child"));
            assert_eq!(state["tabs"][1]["owner"], state["tabs"][0]["owner"]);
            assert_eq!(state["tabs"][1]["popup"], false);
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "new tab did not open: {state}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// A page that opens a popup on load (blocked: no gesture), shown in the App's browser.
async fn blocked_popup_page(
    sandbox: &Sandbox,
) -> Result<
    (
        Shell,
        std::net::SocketAddr,
        tokio_util::task::AbortOnDropHandle<()>,
    ),
    HarnessError,
> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/", axum::routing::get(|| async {
        axum::response::Html("<title>Ready</title><script>onmessage=e=>{if(e.origin===location.origin)document.title=e.data};onload=()=>window.open('/child','p','width=400')</script>")
    })).route("/child", axum::routing::get(|| async {
        axum::response::Html("<title>Sign in</title><script>window.opener.postMessage('Opener intact',location.origin)</script>")
    }));
    let server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            &format!("type http://{address}/"),
            "key enter",
            "wait-anchor browser-band",
        ])
        .await?;
    Ok((shell, address, server))
}

#[tokio::test]
async fn cef_popup_without_gesture_is_blocked_then_allowed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_popup_without_gesture_is_blocked_then_allowed")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let (mut shell, address, _server) = blocked_popup_page(&sandbox).await?;
    let state = shell.browser_state().await?;
    assert_eq!(state["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(state["tabs"][0]["blocked_popup"]["reason"], "no_gesture");
    assert_eq!(
        state["tabs"][0]["blocked_popup"]["url"],
        format!("http://{address}/child")
    );
    shell
        .run(&[
            "click browser-popup-allow",
            "wait-anchor browser-popup-window",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let state = shell.browser_state().await?;
        if state["tabs"][0]["title"] == "Opener intact" {
            assert_eq!(state["tabs"].as_array().unwrap().len(), 2);
            assert_eq!(state["tabs"][1]["popup"], true);
            assert_eq!(state["tabs"][1]["opener"], state["tabs"][0]["id"]);
            assert!(state["tabs"][0]["blocked_popup"].is_null());
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "opener relation was not preserved: {state}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell
        .run(&[
            "click browser-popup-show",
            "key secondary-w",
            "wait-no-anchor browser-popup-window",
        ])
        .await?;
    assert_eq!(
        shell.browser_state().await?["tabs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn cef_page_dialogs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_page_dialogs")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/", axum::routing::get(|| async {
        axum::response::Html("<title>Ready</title><body style='margin:0'><button style='position:absolute;top:0;height:40px;width:120px' onclick=\"alert('Hello');document.title='alert-ok'\">Alert</button><button style='position:absolute;top:40px;height:40px;width:120px' onclick=\"document.title='confirm-'+confirm('Continue?')\">Confirm</button><button style='position:absolute;top:80px;height:40px;width:120px' onclick=\"document.title='prompt-'+prompt('Name','')\">Prompt</button></body>")
    }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "browser",
            "wait-anchor browser-area",
            &format!("type http://{address}/"),
            "key enter",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while shell.browser_state().await?["tabs"][0]["title"] != "Ready" {
        assert!(tokio::time::Instant::now() < deadline, "page did not load");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    for (y, kind, expected) in [
        (20, "alert", "alert-ok"),
        (60, "confirm", "confirm-false"),
        (100, "prompt", "prompt-Ada"),
    ] {
        shell
            .run(&[
                &format!("page-click 20 {y}"),
                "wait-anchor browser-page-dialog",
            ])
            .await?;
        assert_eq!(
            shell.browser_state().await?["tabs"][0]["dialog"]["kind"],
            kind
        );
        if kind == "prompt" {
            shell
                .run(&["click browser-dialog-input", "type Ada"])
                .await?;
        }
        shell
            .run(&[
                if kind == "confirm" {
                    "click browser-dialog-cancel"
                } else {
                    "click browser-dialog-ok"
                },
                "wait-no-anchor browser-page-dialog",
            ])
            .await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let state = shell.browser_state().await?;
            if state["tabs"][0]["title"] == expected {
                assert!(state["tabs"][0]["dialog"].is_null());
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "dialog answer did not reach page: {state}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// The App window is a main window, not any window: with the main window closed and a browser
/// popup window still open, the tray's Open brings a main window back.
#[tokio::test]
async fn closed_main_window_comes_back_beside_a_popup_window() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("closed_main_window_comes_back_beside_a_popup_window")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let (mut shell, _address, _server) = blocked_popup_page(&sandbox).await?;
    shell
        .run(&[
            "click browser-popup-allow",
            "wait-anchor browser-popup-window",
            "close-window",
            "expect-no-anchor composer",
            "expect-anchor browser-popup-window",
            "tray-open",
            "wait-anchor composer",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
