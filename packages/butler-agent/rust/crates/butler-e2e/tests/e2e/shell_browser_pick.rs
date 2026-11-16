//! Selection mode through the live CEF page surface and the stub provider.
#![allow(clippy::unwrap_used, clippy::panic, reason = "E2E assertions")]
use super::shell_app::{
    driver::{SERIAL, SHOTS, Shell},
    live_turns::ready_workspace,
};
use butler_e2e::e2e::{
    HarnessError, config::nonempty, fake_servers::ChatBehavior, sandbox::Sandbox,
};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn cef_pick_mode_picks_and_copies_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(nonempty("BUTLER_CEF_DIR").is_some(), "CEF is not set");
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_pick_mode_picks_and_copies_text")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/",axum::routing::get(|| async { axum::response::Html("<title>Pick</title><body style='margin:0'><h1 style='margin:0;height:60px'>First heading</h1><h2 style='margin:0;height:60px'>Second heading</h2><p style='margin:0;height:60px'>Paragraph text</p></body>") }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "size 1280 800",
            "browser",
            "wait-anchor browser-area",
            &format!("type http://{address}/"),
            "key enter",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while shell.browser_state().await?["tabs"][0]["title"] != "Pick" {
        assert!(tokio::time::Instant::now() < deadline, "page did not load");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell
        .run(&[
            "click browser-pick",
            "wait-anchor browser-pick-band",
            "wait-anchor browser-selection-count-0",
            "page-move 20 140",
            "page-click 20 140",
            "wait-anchor browser-selection-count-1",
            "wait-anchor browser-pick-outline",
            "page-click 20 20 shift",
            "wait-anchor browser-selection-count-2",
            "shot pick-two-selected",
        ])
        .await?;
    let state = shell.browser_state().await?;
    assert_eq!(state["tabs"][0]["selections"][0]["text"], "Paragraph text");
    assert_eq!(state["tabs"][0]["selections"][1]["text"], "First heading");
    shell
        .run(&[
            "click-at browser-selection-count-2 0.60 0.94",
            "expect-clipboard \"Paragraph text\\n\\nFirst heading\"",
            "key escape",
            "wait-no-anchor browser-pick-band",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn cef_pick_attach_reaches_the_composer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(nonempty("BUTLER_CEF_DIR").is_some(), "CEF is not set");
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("cef_pick_attach_reaches_the_composer")?;
    let provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let pages = axum::Router::new().route("/",axum::routing::get(|| async { axum::response::Html("<title>Attach</title><body style='margin:0'><p style='margin:0;height:60px'>Picked paragraph</p></body>") }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer", "size 1280 800"])
        .await?;
    let gw = super::shell_app::gateway(&shell.launch);
    let created = gw
        .post(
            "/sessions",
            json!({"kind":"chat","title":"Pick attachment"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"].as_str().unwrap().to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
            &format!("browser-link http://{address}/"),
            "wait-anchor browser-area",
        ])
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while shell.browser_state().await?["tabs"][0]["title"] != "Attach" {
        assert!(tokio::time::Instant::now() < deadline, "page did not load");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    shell
        .run(&[
            "click browser-pick",
            "page-move 20 20",
            "page-click 20 20",
            "wait-anchor browser-selection-count-1",
            "click-at browser-selection-count-1 0.35 0.94",
            "wait-anchor composer-attachments",
            "click composer",
            "type Describe the picked element",
            "key enter",
            "answer ",
        ])
        .await?;
    let requests = provider.chat_requests();
    assert!(
        requests.iter().any(|r| {
            let body = r.to_string();
            body.contains("web_page_data") && body.contains("Picked paragraph")
        }),
        "element data did not reach the stub: {requests:?}"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// Hover, pick and wheel use page pixels (content pixels times the text-size zoom).
#[tokio::test]
async fn cef_pick_and_wheel_follow_text_size() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), "shell harness is not set");
    butler_e2e::skip_unless!(nonempty("BUTLER_CEF_DIR").is_some(), "CEF is not set");
    let _serial = SERIAL.lock().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let page = "<title>Zoom</title><body style='margin:0'><h1 style='margin:0;height:60px'>Heading</h1><p id=p style='margin:0;height:60px'>Zoom paragraph</p><div style='height:3000px'></div><script>function r(){const b=document.getElementById('p').getBoundingClientRect();document.title='Zoom '+JSON.stringify({r:[b.x,b.y,b.width,b.height],y:scrollY,w:innerWidth})}addEventListener('scroll',r);addEventListener('resize',r);r()</script></body>";
    let pages = axum::Router::new().route(
        "/",
        axum::routing::get(move || async move { axum::response::Html(page) }),
    );
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    for (zoom, keys) in [(1.0_f64, 0), (1.3, 2)] {
        let mut sandbox = Sandbox::new(&format!("cef_pick_and_wheel_follow_text_size_{keys}"))?;
        let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
        let mut shell = Shell::start(&sandbox, &[]).await?;
        shell
            .run(&["agent running", "wait-anchor composer", "size 1280 800"])
            .await?;
        for _ in 0..keys {
            shell.run(&["key secondary-="]).await?;
        }
        shell
            .run(&[
                &format!("expect-scale {zoom}"),
                "browser",
                "wait-anchor browser-area",
                &format!("type http://{address}/"),
                "key enter",
            ])
            .await?;
        let report = loaded_title(&mut shell).await?;
        let [x, y, w, h] = report["r"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect::<Vec<_>>()[..]
        else {
            panic!("paragraph rect missing: {report}");
        };
        let (cx, cy) = ((x + w / 2.) / zoom, (y + h / 2.) / zoom);
        shell
            .run(&[
                "click browser-pick",
                "wait-anchor browser-pick-band",
                &format!("page-move {cx} {cy}"),
            ])
            .await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let label = loop {
            let state = shell.browser_state().await?;
            if let Some(label) = state["tabs"][0]["pick_hover_label"].as_str() {
                break label.to_owned();
            }
            assert!(tokio::time::Instant::now() < deadline, "no hover label");
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        assert!(
            label.starts_with("p ·"),
            "hover label {label:?} at zoom {zoom}"
        );
        shell
            .run(&[
                &format!("page-click {cx} {cy}"),
                "wait-anchor browser-selection-count-1",
            ])
            .await?;
        let state = shell.browser_state().await?;
        assert_eq!(state["tabs"][0]["selections"][0]["text"], "Zoom paragraph");
        shell
            .run(&[
                "key escape",
                "wait-no-anchor browser-pick-band",
                "page-wheel 200",
            ])
            .await?;
        let scrolled = scrolled_title(&mut shell).await?;
        let scroll_y = scrolled["y"].as_f64().unwrap();
        println!(
            "ZOOM-CHECK zoom={zoom} innerWidth={} rect={:?} label={label:?} wheel=200 scrollY={scroll_y}",
            scrolled["w"], report["r"]
        );
        assert!(
            (scroll_y - 200. * zoom).abs() <= 1.,
            "scrollY {scroll_y} at zoom {zoom}"
        );
        shell.run(&["app-quit"]).await?;
        shell.finish().await?;
        sandbox.mark_success();
    }
    Ok(())
}

async fn title_report(shell: &mut Shell) -> Result<serde_json::Value, HarnessError> {
    let title = shell.browser_state().await?["tabs"][0]["title"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(title
        .strip_prefix("Zoom ")
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or(serde_json::Value::Null))
}

async fn loaded_title(shell: &mut Shell) -> Result<serde_json::Value, HarnessError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let report = title_report(shell).await?;
        if !report.is_null() {
            return Ok(report);
        }
        assert!(tokio::time::Instant::now() < deadline, "page did not load");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The scroll offset once the page stops moving (smooth scrolling animates).
async fn scrolled_title(shell: &mut Shell) -> Result<serde_json::Value, HarnessError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut last = (serde_json::Value::Null, tokio::time::Instant::now());
    loop {
        let report = title_report(shell).await?;
        if report["y"].as_f64().unwrap_or(0.) > 0. {
            if report == last.0 {
                if last.1.elapsed() >= Duration::from_millis(600) {
                    return Ok(report);
                }
            } else {
                last = (report, tokio::time::Instant::now());
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "page did not scroll"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
