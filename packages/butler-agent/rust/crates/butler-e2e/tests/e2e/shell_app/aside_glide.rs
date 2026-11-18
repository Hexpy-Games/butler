//! The docked session-info aside glides with the conversation column, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-21 — With the aside docked (a 1440 px window), the layout moves at once and the
/// column and the aside glide on their own: opening or closing session info leaves the message
/// and the composer at their final x from the first frame (no layout FLIP), they travel
/// together, and the closed aside is unmounted after its exit. Under reduced motion nothing
/// slides.
#[tokio::test]
async fn shell_app_21_aside_glides_with_the_column() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-21")?;
    let behavior = ChatBehavior {
        answer: "Alpha".into(),
        ..Default::default()
    };
    let _model = ready_workspace(&sandbox, behavior).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Aside"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
        ])
        .await?;
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-21"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell.run(&["answer Alpha"]).await?;
    let response = gw.get(&format!("/session-view?session_id={id}")).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let view = response.data();
    let message = view["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|m| m["role"] == "user")
        .expect("user message")["id"]
        .as_str()
        .expect("message id")
        .to_owned();
    let (message, anchors) = (
        format!("message-{message}"),
        "composer slot:conversation-aside-scroll:frame",
    );
    shell
        .run(&[
            "size 1440 900",
            &format!("wait-anchor {message}"),
            "wait-anchor session-info-toggle",
            "wait 600",
            &format!("layout rest {message} composer"),
            &format!("glide-layout session-info-toggle open {message} {anchors}"),
            &format!("glide-layout session-info-toggle close {message} {anchors}"),
            "click session-info-toggle",
            &format!("layout rm-open {message} composer"),
            "click session-info-toggle",
            &format!("layout rm-closed {message} composer"),
            "app-quit",
        ])
        .await?;
    let rest = |anchor: &str| laid_out(&shell, "rest", anchor).expect("anchor at rest");
    let (rest_message, rest_composer) = (rest(&message)[0], rest("composer")[0]);
    let (open, close) = (glide_frames(&shell, "open"), glide_frames(&shell, "close"));
    let x =
        |frame: &[(String, Option<[f64; 4]>)], anchor: &str| at(frame, anchor).expect(anchor)[0];
    // Open: the layout is final from the first frame, and the column has moved left.
    let end = &open[40];
    for frame in &open[1..] {
        assert!(near(x(frame, &message), x(end, &message)), "open message x");
        assert!(
            near(x(frame, "composer"), x(end, "composer")),
            "open composer x"
        );
    }
    assert!(
        x(end, &message) < rest_message - 0.5,
        "the column moved left"
    );
    assert!(
        near(
            x(end, &message) - x(end, "composer"),
            rest_message - rest_composer
        ),
        "the message and the composer travel together"
    );
    let aside = at(end, "slot:conversation-aside-scroll:frame").expect("aside at frame 40");
    let composer = at(end, "composer").expect("composer");
    assert!(
        aside[0] >= composer[0] + composer[2] - 0.5,
        "{aside:?} {composer:?}"
    );
    // Close: the layout is at rest from the first frame, and the aside is gone after its exit.
    for frame in &close[1..] {
        assert!(near(x(frame, &message), rest_message), "close message x");
        assert!(
            near(x(frame, "composer"), rest_composer),
            "close composer x"
        );
    }
    assert!(
        at(&close[40], "slot:conversation-aside-scroll:frame").is_none(),
        "the aside is unmounted after its exit"
    );
    // Reduced motion: the layout is the same, nothing slides.
    let rm = |name: &str, anchor: &str| laid_out(&shell, name, anchor).expect("anchor")[0];
    assert!(
        near(rm("rm-open", &message), x(end, &message)),
        "rm-open message"
    );
    assert!(
        near(rm("rm-open", "composer"), x(end, "composer")),
        "rm-open composer"
    );
    assert!(
        near(rm("rm-closed", &message), rest_message),
        "rm-closed message"
    );
    assert!(
        near(rm("rm-closed", "composer"), rest_composer),
        "rm-closed composer"
    );
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
