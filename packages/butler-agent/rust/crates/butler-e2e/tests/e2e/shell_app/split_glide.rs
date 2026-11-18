//! The browser pane's open and close glide through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-24 — The browser pane opens and closes with motion: the pane keeps its final size
/// on every frame it is present (one size change per open for the page, none while it moves or
/// closes), it is held while it leaves and gone after, and the chat column's width changes per
/// frame between its open and closed widths.
#[tokio::test]
async fn shell_app_24_split_pane_glides() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-24")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Split"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-24"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
            "browser-link https://example.com/",
            "wait-anchor browser-area",
            "wait 600",
            "layout open split-chat browser-area",
            "glide-layout titlebar-browser-toggle close split-chat browser-area",
            "layout closed split-chat",
            "glide-layout titlebar-browser-toggle reopen split-chat browser-area",
            "layout reopened split-chat browser-area",
            "app-quit",
        ])
        .await?;
    let pane = laid_out(&shell, "open", "browser-area").expect("pane open");
    let (open_w, closed_w) = (
        laid_out(&shell, "open", "split-chat").expect("chat open")[2],
        laid_out(&shell, "closed", "split-chat").expect("chat closed")[2],
    );
    let (close, reopen) = (
        glide_frames(&shell, "close"),
        glide_frames(&shell, "reopen"),
    );
    let chat = |frames: &[Vec<(String, Option<[f64; 4]>)>]| -> Vec<f64> {
        frames
            .iter()
            .filter_map(|f| at(f, "split-chat"))
            .map(|b| b[2])
            .collect()
    };
    let between = |widths: &[f64]| {
        widths
            .iter()
            .filter(|w| **w > open_w + 0.5 && **w < closed_w - 0.5)
            .count()
    };
    let same_pane = |b: [f64; 4]| (0..4).all(|i| near(b[i], pane[i]));
    // Close: the pane is not squeezed, is held on the first frame and unmounted by the last.
    for frame in &close {
        assert!(
            at(frame, "browser-area").is_none_or(same_pane),
            "pane resized"
        );
    }
    assert!(
        at(&close[1], "browser-area").is_some(),
        "pane held while leaving"
    );
    assert!(at(&close[40], "browser-area").is_none(), "pane unmounted");
    let widths = chat(&close);
    assert!(
        widths.windows(2).all(|w| w[1] >= w[0] - 0.01) && near(widths[0], open_w),
        "chat widens: {widths:?}"
    );
    assert!(between(&widths) >= 3, "chat width per frame: {widths:?}");
    assert!(
        near(widths[40], closed_w),
        "chat ends at the closed width: {widths:?}"
    );
    // Reopen: the pane is final from the first frame and the chat narrows per frame.
    for frame in &reopen[1..] {
        assert!(
            at(frame, "browser-area").is_some_and(same_pane),
            "pane resized"
        );
    }
    let widths = chat(&reopen);
    assert!(
        widths.windows(2).all(|w| w[1] <= w[0] + 0.01) && near(widths[0], closed_w),
        "chat narrows: {widths:?}"
    );
    assert!(between(&widths) >= 3, "chat width per frame: {widths:?}");
    assert!(
        near(widths[40], open_w),
        "chat ends at the open width: {widths:?}"
    );
    let reopened = laid_out(&shell, "reopened", "browser-area").expect("pane reopened");
    let chat_reopened = laid_out(&shell, "reopened", "split-chat").expect("chat reopened");
    assert!(
        same_pane(reopened) && near(chat_reopened[2], open_w),
        "reopened equals open"
    );
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
