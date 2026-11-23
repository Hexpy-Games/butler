//! The composer card's fold motion through the native shell.
use super::live_turns::ready_workspace;
use super::popover_scroll::{anchor_field, layout};
use super::*;

/// SHELL-APP-13 — The composer folds with motion: in a new chat the engaged composer is unfolded;
/// a real click elsewhere folds it, and the card's height passes through values between open and
/// folded over the exit motion instead of jumping, as Electron's CSS height transition does (the
/// card's glass follows a layout height).
/// A vertical wheel over the suggestion rail moves neither the rail nor the page around it, as in
/// Electron, where the rail has no wheel handler and the new chat's scroller is locked.
#[tokio::test]
async fn shell_app_13_composer_folds_with_motion() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-13")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "new",
            "compose",
            "expect-composer-focus",
            "expect-click-glide titlebar composer",
        ])
        .await?;
    // A vertical wheel over the suggestion rail moves neither the rail nor the page around it.
    shell.run(&["size 900 800", "wait 500"]).await?;
    let rail = "new-chat-rail";
    let row = "new-chat-rail-content";
    let anchors = format!("{rail} {row}");
    let before = layout(&mut shell, "rail-before", &anchors).await?;
    shell
        .run(&[&format!("wheel {rail} -3 0.5 0.5 lines"), "wait 500"])
        .await?;
    let after = layout(&mut shell, "rail-after", &anchors).await?;
    let at = |layout: &Value, anchor: &str, key: &str| {
        anchor_field(layout, anchor, key).expect("rail anchor")
    };
    let measured = format!(
        "rail w {}, row w {}; row moved x {} y {}, rail moved y {}",
        at(&before, rail, "w"),
        at(&before, row, "w"),
        at(&after, row, "x") - at(&before, row, "x"),
        at(&after, row, "y") - at(&before, row, "y"),
        at(&after, rail, "y") - at(&before, rail, "y"),
    );
    println!("SHELL-APP-13 {measured}");
    assert!(
        at(&before, row, "w") > at(&before, rail, "w") + 1.,
        "(control) the rail does not overflow: {measured}"
    );
    for (anchor, key) in [(row, "x"), (row, "y"), (rail, "y")] {
        assert!(
            (at(&after, anchor, key) - at(&before, anchor, key)).abs() <= 0.5,
            "a vertical wheel over the rail moved {anchor} {key}: {measured}"
        );
    }
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
