//! Conversation downloads through the real CEF shell and a local attachment server.
#![allow(clippy::unwrap_used, clippy::panic, reason = "E2E assertions")]
use super::shell_app::{
    driver::{SERIAL, SHOTS, Shell},
    gateway,
    live_turns::ready_workspace,
};
use butler_e2e::e2e::{
    HarnessError, config::nonempty, fake_servers::ChatBehavior, sandbox::Sandbox,
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn cef_conversation_download_lands_in_the_workspace() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_conversation_download_lands_in_the_workspace")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/", axum::routing::get(|| async {
        axum::response::Html("<title>Download ready</title><body style='margin:0'><a style='display:block;width:150px;height:40px' href='/attachment'>Download report</a></body>")
    })).route("/attachment", axum::routing::get(|| async {
        ([("content-type", "text/csv"), ("content-disposition", "attachment; filename=\"report?.csv\"")], super::browser_headless::support::REPORT)
    }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind":"chat","title":"Download"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let session = created.data()["session"]["id"].as_str().unwrap().to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{session}"),
            &format!("open {session}"),
            &format!("browser-link http://{address}/"),
            "wait-anchor browser-area",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while shell.browser_state().await?["tabs"][0]["title"] != "Download ready" {
        assert!(
            tokio::time::Instant::now() < deadline,
            "attachment page did not load"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell
        .run(&["page-click 20 20", "wait-anchor toast-front"])
        .await?;
    let state = shell.browser_state().await?;
    let events = state["download_events"][format!("conversation:{session}")]
        .as_array()
        .unwrap();
    let done = events
        .iter()
        .find(|e| e["type"] == "download_completed")
        .unwrap_or_else(|| panic!("{state}"));
    assert_eq!(done["path"], "downloads/report_.csv", "{done}");
    assert_eq!(
        done["size_bytes"],
        super::browser_headless::support::REPORT.len(),
        "{done}"
    );
    let output = done["output_id"].as_str().unwrap();
    let artifacts = gw.get(&format!("/artifacts?session_id={session}")).await?;
    assert!(artifacts.text.contains(output), "{}", artifacts.text);
    let view = gw.get(done["view"].as_str().unwrap()).await?;
    let bytes = reqwest::get(view.data()["url"].as_str().unwrap())
        .await?
        .bytes()
        .await?;
    assert_eq!(
        bytes.as_ref(),
        super::browser_headless::support::REPORT.as_bytes()
    );
    let admin =
        butler_e2e::e2e::security::AdminClient::new(gw, shell.launch.admin_credential().unwrap());
    let context = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser-host/downloads",
            Some(json!({"op":"prepare","session":session,"tab":state["tabs"][0]["id"]})),
            &[],
        )
        .await?;
    assert_eq!(context.status, 200, "{}", context.text);
    let context: serde_json::Value = serde_json::from_str(&context.text)?;
    let root = std::path::Path::new(context["workspace_path"].as_str().unwrap());
    assert!(root.starts_with(&sandbox.root));
    assert_eq!(
        std::fs::read(root.join("downloads/report_.csv"))?,
        super::browser_headless::support::REPORT.as_bytes()
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn cef_download_over_the_file_limit_is_refused() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_download_over_the_file_limit_is_refused")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/", axum::routing::get(|| async {
        axum::response::Html("<title>Download ready</title><body style='margin:0'><a style='display:block;width:150px;height:40px' href='/attachment'>Download report</a></body>")
    })).route("/attachment", axum::routing::get(|| async {
        let stream = futures_util::stream::unfold(101_000_000_usize, |remaining| async move {
            if remaining == 0 { return None; }
            let count = remaining.min(64 * 1024);
            Some((Ok::<_, std::io::Error>(bytes::Bytes::from(vec![b'x'; count])), remaining - count))
        });
        ([("content-type", "application/octet-stream"), ("content-disposition", "attachment; filename=large.bin"), ("content-length", "101000000")], axum::body::Body::from_stream(stream))
    }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind":"chat","title":"Download limit"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let session = created.data()["session"]["id"].as_str().unwrap().to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{session}"),
            &format!("open {session}"),
            &format!("browser-link http://{address}/"),
            "wait-anchor browser-area",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while shell.browser_state().await?["tabs"][0]["title"] != "Download ready" {
        assert!(
            tokio::time::Instant::now() < deadline,
            "attachment page did not load"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell
        .run(&["page-click 20 20", "wait-anchor toast-front"])
        .await?;
    let state = shell.browser_state().await?;
    let events = state["download_events"][format!("conversation:{session}")]
        .as_array()
        .unwrap();
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "download_refused" && e["reason"] == "download_file_limit"),
        "{state}"
    );
    assert!(
        !events.iter().any(|e| e["type"] == "download_completed"),
        "{state}"
    );
    let admin = butler_e2e::e2e::security::AdminClient::new(
        gw.clone(),
        shell.launch.admin_credential().unwrap(),
    );
    let context = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser-host/downloads",
            Some(json!({"op":"prepare","session":session,"tab":state["tabs"][0]["id"]})),
            &[],
        )
        .await?;
    assert_eq!(context.status, 200, "{}", context.text);
    let context: serde_json::Value = serde_json::from_str(&context.text)?;
    assert!(
        !std::path::Path::new(context["workspace_path"].as_str().unwrap())
            .join("downloads")
            .exists()
    );
    let artifacts = gw.get(&format!("/artifacts?session_id={session}")).await?;
    assert!(!artifacts.text.contains("large.bin"), "{}", artifacts.text);
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
