//! A wheel over a non-modal popover, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// The vertical position of `anchor` in the layout `name` wrote.
pub(super) fn anchor_y(layout: &Value, anchor: &str) -> Option<f64> {
    anchor_field(layout, anchor, "y")
}

/// A number (`y`, `h`, …) of `anchor` in a layout report.
fn anchor_field(layout: &Value, anchor: &str, key: &str) -> Option<f64> {
    layout
        .as_array()?
        .iter()
        .find(|item| item["anchor"] == anchor)?[key]
        .as_f64()
}

/// Writes the layout of the transcript and of `anchors`, and returns the report.
pub(super) async fn layout(
    shell: &mut Shell,
    name: &str,
    anchors: &str,
) -> Result<Value, HarnessError> {
    shell
        .run(&[&format!("layout {name} chat-transcript {anchors}")])
        .await?;
    shell.report(&format!("{name}.layout"))
}

/// A message row inside the transcript's viewport, to follow while the list may scroll.
fn visible_message(layout: &Value) -> String {
    let top = anchor_field(layout, "chat-transcript", "y").expect("transcript");
    let height = anchor_field(layout, "chat-transcript", "h").expect("transcript");
    layout
        .as_array()
        .expect("layout")
        .iter()
        .filter_map(|item| item["anchor"].as_str())
        .find(|anchor| {
            anchor.starts_with("message-")
                && anchor_y(layout, anchor).is_some_and(|y| y > top + 10. && y < top + height)
        })
        .expect("a message in view")
        .to_owned()
}

/// SHELL-APP-20 — A wheel over a non-modal popover (the session menu) scrolls the popover's own
/// list when it has one and nothing behind it: the conversation under it stays where it is. A
/// press outside it still closes it. (A DOM overlay on top takes the wheel, and its scroller has
/// `overscroll-behavior: contain`.) A wheel over the sidebar's peek card never scrolls the
/// conversation under it.
#[tokio::test]
async fn shell_app_20_wheel_over_a_popover_stays_in_the_popover() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-20")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    // A chat long enough to scroll.
    for n in 0..12 {
        let turn = gw
            .say_turn("general", &format!("Filler question {n}."))
            .await?;
        gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    }
    shell
        .run(&["open general", "wait-anchor composer", "size 1200 800"])
        .await?;
    // Away from the end, with room to scroll either way.
    shell
        .run(&["wheel chat-transcript 300", "wait 500"])
        .await?;
    let base = layout(&mut shell, "base", "").await?;
    let message = visible_message(&base);
    let y0 = anchor_y(&base, &message).expect("message y");
    // Control: a wheel over the conversation itself moves it.
    shell.run(&["wheel chat-transcript 60", "wait 500"]).await?;
    let moved = layout(&mut shell, "moved", &message).await?;
    let control = anchor_y(&moved, &message).expect("message y") - y0;

    let (list_dy, chat_dy) = popover_scroll(&mut shell).await?;
    let (peek_control, card_right, transcript_left, peek_dy) = peek_scroll(&mut shell).await?;
    let measured = format!(
        "control (wheel over the chat) moved it {control}; capped list: chat moved {chat_dy}, \
         list moved {list_dy}; peek control {peek_control}; peek card right {card_right}, \
         transcript left {transcript_left}; peek chat moved {peek_dy}"
    );
    println!("SHELL-APP-20 {measured}");
    let mut failed = Vec::new();
    if control.abs() < 20. {
        failed.push("(control) the wheel over the chat did not move it");
    }
    if chat_dy.abs() > 0.5 {
        failed.push("the chat scrolled behind a popover's list");
    }
    if list_dy.abs() < 5. {
        failed.push("the popover's list did not scroll");
    }
    if peek_control <= 20. {
        failed.push("(peek control) the wheel over the chat did not move it");
    }
    if card_right <= transcript_left + 1. {
        failed.push("the peek card did not lie over the transcript");
    }
    if peek_dy.abs() > 0.5 {
        failed.push("the chat scrolled behind the peek card");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

async fn popover_scroll(shell: &mut Shell) -> Result<(f64, f64), HarnessError> {
    // A popover whose list is taller than its cap: the list moves, the conversation stays.
    shell
        .run(&[
            "size 1200 150",
            "wait 500",
            "wheel chat-transcript 100",
            "wait 500",
        ])
        .await?;
    let small = layout(shell, "small", "").await?;
    let message = visible_message(&small);
    let item = "session-menu-item-0-0";
    shell
        .run(&[
            "click session-menu-trigger",
            "wait-anchor menu-content",
            &format!("wait-anchor {item}"),
        ])
        .await?;
    let anchors = format!("{message} {item} menu-content");
    let open = layout(shell, "open", &anchors).await?;
    let (item0, chat0) = (
        anchor_y(&open, item).expect("item y"),
        anchor_y(&open, &message).expect("message y"),
    );
    shell.run(&["wheel menu-content -30", "wait 500"]).await?;
    let after = layout(shell, "after", &anchors).await?;
    let list_dy = anchor_y(&after, item).expect("item y") - item0;
    let chat_dy = anchor_y(&after, &message).expect("message y") - chat0;
    shell
        .run(&[
            "click-at chat-transcript 0.5 0.5",
            "wait-no-anchor menu-content",
        ])
        .await?;
    Ok((list_dy, chat_dy))
}

async fn peek_scroll(shell: &mut Shell) -> Result<(f64, f64, f64, f64), HarnessError> {
    shell
        .run(&[
            "size 1200 800",
            "wait 500",
            "wheel chat-transcript 300",
            "wait 500",
        ])
        .await?;
    let base2 = layout(shell, "base2", "").await?;
    let message = visible_message(&base2);
    let y0 = anchor_y(&base2, &message).expect("message y");
    shell.run(&["wheel chat-transcript 60", "wait 500"]).await?;
    let moved = layout(shell, "b-moved", &message).await?;
    let control = anchor_y(&moved, &message).expect("message y") - y0;
    shell
        .run(&[
            "click sidebar-toggle",
            "wait 600",
            "hover peek-edge-zone",
            "wait-anchor peek-card",
            "wait 600",
        ])
        .await?;
    let anchors = format!("{message} peek-card");
    let open = layout(shell, "b-open", &anchors).await?;
    let card_right = anchor_field(&open, "peek-card", "x").expect("peek x")
        + anchor_field(&open, "peek-card", "w").expect("peek width");
    let transcript_left = anchor_field(&open, "chat-transcript", "x").expect("transcript x");
    shell
        .run(&[
            "wheel peek-card 60 0.5 0.9",
            "wait 500",
            "expect-anchor peek-card",
        ])
        .await?;
    let after = layout(shell, "b-after", &anchors).await?;
    let chat_dy = anchor_y(&after, &message).expect("message y")
        - anchor_y(&open, &message).expect("message y");
    Ok((control, card_right, transcript_left, chat_dy))
}

/// SHELL-APP-26 — A wheel over the image viewer, or over the drawer backdrop of the overlaid
/// sidebar, never scrolls the conversation behind it (the web's surface on top takes the wheel).
#[tokio::test]
async fn shell_app_26_wheel_over_the_image_viewer_never_scrolls_the_chat()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-26")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    // A chat long enough to scroll.
    for n in 0..12 {
        let turn = gw
            .say_turn("general", &format!("Filler question {n}."))
            .await?;
        gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    }
    shell
        .run(&["open general", "wait-anchor composer", "size 1200 800"])
        .await?;
    // Away from the end, with room to scroll either way.
    shell
        .run(&["wheel chat-transcript 300", "wait 500"])
        .await?;
    let base = layout(&mut shell, "v-base", "").await?;
    let message = visible_message(&base);
    let y0 = anchor_y(&base, &message).expect("message y");
    // Control: a wheel over the conversation itself moves it.
    shell.run(&["wheel chat-transcript 60", "wait 500"]).await?;
    let moved = layout(&mut shell, "v-moved", &message).await?;
    let control = anchor_y(&moved, &message).expect("message y") - y0;

    shell
        .run(&[
            "size 400 700",
            "wait 500",
            "wheel chat-transcript 100",
            "wait 500",
        ])
        .await?;
    let small = layout(&mut shell, "v-small", "").await?;
    let message = visible_message(&small);
    shell
        .run(&[
            "click sidebar-toggle",
            "wait-anchor adaptive-scrim",
            "wait 600",
        ])
        .await?;
    let open = layout(&mut shell, "v-drawer-open", &message).await?;
    let y0 = anchor_y(&open, &message).expect("message y");
    shell
        .run(&["wheel adaptive-scrim 60 0.95 0.5", "wait 500"])
        .await?;
    let after = layout(&mut shell, "v-drawer-after", &message).await?;
    let drawer_dy = anchor_y(&after, &message).expect("message y") - y0;
    shell
        .run(&[
            "click-at adaptive-scrim 0.95 0.5",
            "wait-no-anchor adaptive-scrim",
        ])
        .await?;

    shell.run(&["size 1200 800", "wait 500"]).await?;
    let wide = layout(&mut shell, "v-wide", "").await?;
    let message = visible_message(&wide);
    shell
        .run(&["image-viewer shell-app-26", "wait 600"])
        .await?;
    let open = layout(&mut shell, "v-viewer-open", &message).await?;
    let y0 = anchor_y(&open, &message).expect("message y");
    shell.run(&["wheel chat-transcript 60", "wait 500"]).await?;
    let after = layout(&mut shell, "v-viewer-after", &message).await?;
    let viewer_dy = anchor_y(&after, &message).expect("message y") - y0;
    shell.run(&["key escape", "wait 600"]).await?;

    let measured = format!(
        "control {control}; drawer backdrop: chat moved {drawer_dy}; image viewer: chat moved {viewer_dy}"
    );
    println!("SHELL-APP-26 {measured}");
    let mut failed = Vec::new();
    if control.abs() < 20. {
        failed.push("(control) the wheel over the chat did not move it");
    }
    if drawer_dy.abs() > 0.5 {
        failed.push("the chat scrolled behind the drawer backdrop");
    }
    if viewer_dy.abs() > 0.5 {
        failed.push("the chat scrolled behind the image viewer");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
