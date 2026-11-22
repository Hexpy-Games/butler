//! Nested activity scrolling and the sidebar peek through the native shell.
use super::activity_tools::comparing_activity;
use super::live_turns::ready_workspace;
use super::observer_dialog::finished_child;
use super::popover_scroll::{anchor_field, anchor_y, layout, visible_message};
use super::*;

/// SHELL-APP-27 — In a task card's open activity details, a wheel moves only the details; a
/// trackpad gesture and its momentum that reach the details' end stop there; the next gesture
/// moves the conversation; a wheel the details cannot follow moves the conversation.
#[tokio::test]
async fn shell_app_27_a_wheel_in_activity_details_stays_in_the_details() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let (mut sandbox, chat, child) = finished_child("SHELL-APP-27").await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell.run(&["agent running"]).await?;
    let view = gateway(&shell.launch)
        .get(&format!("/session-view?session_id={}", child.session))
        .await?;
    let rows = view.data()["latest_turn"]["progress"]["safe_progress_rows"]
        .as_array()
        .expect("progress rows")
        .clone();
    let activity = comparing_activity(&rows)
        .unwrap_or_else(|| panic!("no comparing activity: {}", Value::Array(rows.clone())));
    let sid = &child.session;
    let det = format!("work-details-{sid}");
    let edge = format!("work-details-edge-{sid}");
    let act = format!("activity-{activity}");
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{chat}"),
            &format!("open {chat}"),
            "size 900 600",
            &format!("wait-anchor steward-disclosure-{sid}"),
            &format!("click steward-disclosure-{sid}"),
            &format!("wait-anchor {det}"),
            &format!("click {act}-group-button"),
            &format!("wait-anchor {act}-group-row-0"),
            &format!("click {act}-group-row-0"),
            "wait 500",
            &format!("expect-anchor {edge}:start"),
        ])
        .await?;
    let a0 = layout(&mut shell, "a0", &det).await?;
    shell
        .run(&[&format!("wheel {det} 60 0.5 0.3"), "wait 500"])
        .await?;
    let a1 = layout(&mut shell, "a1", &det).await?;
    let control = anchor_y(&a1, &det).expect("details y") - anchor_y(&a0, &det).expect("details y");
    shell
        .run(&[
            &format!("wheel {det} -20 0.5 0.3"),
            "wait 500",
            &format!("expect-anchor {edge}:middle"),
        ])
        .await?;
    let a2 = layout(&mut shell, "a2", &det).await?;
    let inner = anchor_y(&a2, &det).expect("details y") - anchor_y(&a1, &det).expect("details y");
    shell
        .run(&[
            &format!("wheel {det} -10 0.5 0.3 started"),
            &format!("wheel {det} -2000 0.5 0.3 moved"),
            &format!("wheel {det} -100 0.5 0.3 moved"),
            &format!("wheel {det} 0 0.5 0.3 ended"),
            &format!("wheel {det} -300 0.5 0.3 momentum"),
            &format!("wheel {det} -300 0.5 0.3 momentum"),
            "wait 500",
            &format!("expect-anchor {edge}:end"),
        ])
        .await?;
    let a3 = layout(&mut shell, "a3", &det).await?;
    let fling = anchor_y(&a3, &det).expect("details y") - anchor_y(&a2, &det).expect("details y");
    shell
        .run(&[
            &format!("wheel {det} -10 0.5 0.3 started"),
            &format!("wheel {det} -40 0.5 0.3 moved"),
            &format!("wheel {det} 0 0.5 0.3 ended"),
            "wait 500",
        ])
        .await?;
    let a4 = layout(&mut shell, "a4", &det).await?;
    let next = anchor_y(&a4, &det).expect("details y") - anchor_y(&a3, &det).expect("details y");
    let measured = format!(
        "chat movement: control {control}; inner wheel {inner}; fling and momentum {fling}; \
         next gesture {next}"
    );
    println!("SHELL-APP-27 {measured}");
    let mut failed = Vec::new();
    if control <= 20. {
        failed.push("(control) the wheel the details could not follow did not move the chat");
    }
    if inner.abs() > 0.5 {
        failed.push("the wheel in the details moved the chat");
    }
    if fling.abs() > 0.5 {
        failed.push("the gesture or its momentum moved the chat at the details' end");
    }
    if next >= -5. {
        failed.push("the next gesture did not move the chat toward its end");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// SHELL-APP-28 — A wheel over the peeked sidebar card never scrolls the conversation under it.
#[tokio::test]
async fn shell_app_28_wheel_over_the_sidebar_peek_never_scrolls_the_chat()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-28")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
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
    shell
        .run(&["wheel chat-transcript 300", "wait 500"])
        .await?;
    let base = layout(&mut shell, "base", "").await?;
    let message = visible_message(&base);
    let y0 = anchor_y(&base, &message).expect("message y");
    shell.run(&["wheel chat-transcript 60", "wait 500"]).await?;
    let moved = layout(&mut shell, "moved", &message).await?;
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
    let open = layout(&mut shell, "b-open", &anchors).await?;
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
    let after = layout(&mut shell, "b-after", &anchors).await?;
    let chat_dy = anchor_y(&after, &message).expect("message y")
        - anchor_y(&open, &message).expect("message y");
    let measured = format!(
        "control {control}; peek card right {card_right}, transcript left {transcript_left}; \
         chat moved {chat_dy}"
    );
    println!("SHELL-APP-28 {measured}");
    let mut failed = Vec::new();
    if control <= 20. {
        failed.push("(control) the wheel over the chat did not move it");
    }
    if card_right <= transcript_left + 1. {
        failed.push("the peek card did not lie over the transcript");
    }
    if chat_dy.abs() > 0.5 {
        failed.push("the chat scrolled behind the peek card");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
