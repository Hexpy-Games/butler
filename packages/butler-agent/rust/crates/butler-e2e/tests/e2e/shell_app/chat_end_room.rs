//! The end of a 대화 transcript: answers and the work card stay inside their rows, and the list
//! keeps Electron's room under the last message.
use super::driver::{SERIAL, SHOTS};
use super::*;

/// `conversationUtils.tsx` `COMPOSER_FLOAT_BOTTOM`: the composer's float offset from the card bottom.
const COMPOSER_FLOAT_BOTTOM: f32 = 28.;
/// `conversationUtils.tsx` `COMPOSER_CONTENT_GAP`: the gap between the last message and the composer.
const COMPOSER_CONTENT_GAP: f32 = 20.;
/// The bubbles' and cards' maximum width (`min(440px, 90%)`).
const BUBBLE_MAX: f32 = 440.;

fn rect(layout: &Value, anchor: &str) -> (f32, f32, f32, f32) {
    let item = layout
        .as_array()
        .expect("layout")
        .iter()
        .find(|item| item["anchor"] == anchor)
        .unwrap_or_else(|| panic!("no anchor {anchor} in {layout}"));
    let f = |key: &str| item[key].as_f64().expect("number") as f32;
    (f("x"), f("y"), f("w"), f("h"))
}

/// SHELL-APP-16 — At the end of a long 대화 transcript the work card is as wide as its row allows
/// (`min(440px, 90%)` of the row body), it ends above the response footer under it, and the last
/// row is followed by the list's end room, the composer's height plus
/// `COMPOSER_FLOAT_BOTTOM` plus `COMPOSER_CONTENT_GAP`.
#[tokio::test]
async fn shell_app_16_chat_end_keeps_answers_inside_their_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    // The Agent's stub model delegates once and answers the rest in one line.
    let (url, script, server) = crate::chats_work::stub::start(false, true).await?;
    let (s, _clock) = crate::chats_work::setup("SHELL-APP-16", &url).await?;
    // The first run is done, so the shell opens the workspace.
    let now = "2026-01-01T00:00:00Z";
    let mut onboarding = s.gw.settings().await?["onboarding"].clone();
    onboarding["consent_version"] = json!(2);
    onboarding["accepted_at"] = json!(now);
    onboarding["completed_at"] = json!(now);
    let done =
        s.gw.patch("/settings", json!({"onboarding": onboarding}))
            .await?;
    assert_eq!(done.status, 200, "{}", done.text);
    script
        .delegated
        .store(true, std::sync::atomic::Ordering::SeqCst);
    for n in 0..10 {
        let turn =
            s.gw.say_turn("general", &format!("Filler question {n}."))
                .await?;
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    }
    script
        .delegated
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let turn = s.gw.say_turn("general", "Prepare evidence.").await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .expect("child held")
        .expect("semaphore")
        .forget();
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    script.release.add_permits(1);
    let result = crate::chats_work::wait_count(&s, "work_result", 1)
        .await?
        .remove(0);
    let id = result["id"].as_str().expect("message id").to_owned();
    let mut s = s;
    // Hand the data folder to the shell's own Agent.
    drop(s.agent);
    server.abort();

    let mut shell = Shell::start(&s.sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "size 1200 800",
            "open general",
        ])
        .await?;
    let (card, footer) = (format!("work-card-{id}"), format!("copy-{id}"));
    // Scroll to the bottom: the wheel over the card, as far as it scrolls.
    shell
        .run(&[
            &format!("wait-anchor {card}"),
            &format!("wait-anchor {footer}"),
            "reveal composer chat-card",
            "wait 500",
            &format!("layout end {card} {footer} message-{id}-body chat-end-room"),
        ])
        .await?;
    let layout = shell.report("end.layout")?;
    let (_, _, body_w, _) = rect(&layout, &format!("message-{id}-body"));
    let (_, card_y, card_w, card_h) = rect(&layout, &card);
    let (_, footer_y, _, _) = rect(&layout, &footer);
    let (_, row_y, _, row_h) = rect(&layout, &format!("message-{id}"));
    let (_, composer_y, _, composer_h) = rect(&layout, "composer");
    let (_, end_y, _, room) = rect(&layout, "chat-end-room");
    // The card's own 1px border sits inside the cap.
    let expected_w = BUBBLE_MAX.min(0.9 * body_w) - 2.;
    let (card_bottom, row_bottom) = (card_y + card_h, row_y + row_h);
    let expected_room = (composer_h + COMPOSER_FLOAT_BOTTOM + COMPOSER_CONTENT_GAP).ceil();
    let measured = format!(
        "body {body_w}, card w {card_w} (expected {expected_w}), card bottom {card_bottom}, \
         footer top {footer_y}, last row bottom {row_bottom}, composer top {composer_y}, \
         end room {room} at {end_y} (expected {expected_room} at {row_bottom})"
    );
    println!("SHELL-APP-16 {measured}");
    let mut failed = Vec::new();
    // (a) The card is as wide as the bubble cap allows.
    if (card_w - expected_w).abs() > 1. {
        failed.push("(a) card width");
    }
    // (b) The card's painted box ends above the footer under it.
    if card_bottom > footer_y + 0.5 {
        failed.push("(b) card overlaps the footer");
    }
    // (c) The room that closes the list is the composer's height plus its float offset plus the
    // content gap (Electron's `composerReserve`).
    if (room - expected_room).abs() > 1. {
        failed.push("(c) end room");
    }
    assert!(failed.is_empty(), "{failed:?}: {measured}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    s.sandbox.mark_success();
    Ok(())
}
