//! A wheel over a non-modal popover, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// The vertical position of `anchor` in the layout `name` wrote.
fn anchor_y(layout: &Value, anchor: &str) -> Option<f64> {
    layout
        .as_array()?
        .iter()
        .find(|item| item["anchor"] == anchor)?["y"]
        .as_f64()
}

/// Writes the layout of the transcript and of `anchors`, and returns the report.
async fn layout(shell: &mut Shell, name: &str, anchors: &str) -> Result<Value, HarnessError> {
    shell
        .run(&[&format!("layout {name} chat-transcript {anchors}")])
        .await?;
    shell.report(&format!("{name}.layout"))
}

/// A message row inside the transcript's viewport, to follow while the list may scroll.
fn visible_message(layout: &Value) -> String {
    let items = layout.as_array().expect("layout");
    let find = |anchor: &str| {
        let item = items
            .iter()
            .find(|item| item["anchor"] == anchor)
            .expect("transcript");
        (
            item["y"].as_f64().expect("y"),
            item["h"].as_f64().expect("h"),
        )
    };
    let (top, height) = find("chat-transcript");
    items
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
/// `overscroll-behavior: contain`.)
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
    let y1 = y0 + control;

    // (b) A popover without a scroller: the conversation stays.
    shell
        .run(&[
            "wait-anchor session-menu-trigger",
            "click session-menu-trigger",
            "wait-anchor menu-content",
            "wheel menu-content 60",
            "wait 500",
        ])
        .await?;
    let plain = layout(&mut shell, "plain", &message).await?;
    let plain_dy = anchor_y(&plain, &message).expect("message y") - y1;
    // (c) A press outside closes it.
    shell
        .run(&[
            "click-at chat-transcript 0.5 0.5",
            "wait-no-anchor menu-content",
        ])
        .await?;

    // (a) A popover whose list is taller than its cap: the list moves, the conversation stays.
    shell
        .run(&[
            "size 1200 150",
            "wait 500",
            "wheel chat-transcript 100",
            "wait 500",
        ])
        .await?;
    let small = layout(&mut shell, "small", "").await?;
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
    let open = layout(&mut shell, "open", &anchors).await?;
    let (item0, chat0) = (
        anchor_y(&open, item).expect("item y"),
        anchor_y(&open, &message).expect("message y"),
    );
    shell.run(&["wheel menu-content -30", "wait 500"]).await?;
    let after = layout(&mut shell, "after", &anchors).await?;
    let list_dy = anchor_y(&after, item).expect("item y") - item0;
    let chat_dy = anchor_y(&after, &message).expect("message y") - chat0;
    shell
        .run(&[
            "click-at chat-transcript 0.5 0.5",
            "wait-no-anchor menu-content",
        ])
        .await?;
    let measured = format!(
        "control (wheel over the chat) moved it {control}; (b) popover without a scroller: chat \
         moved {plain_dy}; (a) capped list: chat moved {chat_dy}, list moved {list_dy}"
    );
    println!("SHELL-APP-20 {measured}");
    let mut failed = Vec::new();
    if control.abs() < 20. {
        failed.push("(control) the wheel over the chat did not move it");
    }
    if plain_dy.abs() > 0.5 {
        failed.push("(b) the chat scrolled behind a popover");
    }
    if chat_dy.abs() > 0.5 {
        failed.push("(a) the chat scrolled behind a popover's list");
    }
    if list_dy.abs() < 5. {
        failed.push("(a) the popover's list did not scroll");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
