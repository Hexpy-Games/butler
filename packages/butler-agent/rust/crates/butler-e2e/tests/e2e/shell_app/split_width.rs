//! The browser split keeps its chat width across App restarts.
use super::live_turns::ready_workspace;
use super::*;

fn width(shell: &Shell, name: &str) -> f64 {
    let report = shell
        .report(&format!("{name}.layout"))
        .expect("layout report");
    let card = report
        .as_array()
        .expect("layout array")
        .iter()
        .find(|entry| entry["anchor"] == "chat-card")
        .expect("chat-card");
    card["w"].as_f64().expect("number") + 2.
}

/// SHELL-APP-25 — The chat width dragged beside the browser pane comes back after the App restarts on the same data.
#[tokio::test]
async fn shell_app_25_split_width_survives_a_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-25")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Width"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-25"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
            "size 1400 800",
            "wait 600",
            "browser-link https://example.com/",
            "wait-anchor browser-area",
            "wait 600",
            "layout before chat-card",
            "drag split-handle -150 0",
            "wait 600",
            "layout dragged chat-card",
            "app-quit",
        ])
        .await?;
    let before = width(&shell, "before");
    let dragged = width(&shell, "dragged");
    shell.finish().await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
            "size 1400 800",
            "wait 600",
            "browser-link https://example.com/",
            "wait-anchor browser-area",
            "wait 600",
            "layout restored chat-card",
            "app-quit",
        ])
        .await?;
    let restored = width(&shell, "restored");
    shell.finish().await?;
    assert!(
        dragged <= before - 100.,
        "before {before}, dragged {dragged}"
    );
    assert!(
        (restored - dragged).abs() <= 1.,
        "before {before}, dragged {dragged}, restored {restored}"
    );
    sandbox.mark_success();
    Ok(())
}
