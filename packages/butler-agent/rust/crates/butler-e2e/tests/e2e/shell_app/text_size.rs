//! Text size through the native shell's keyboard shortcuts.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-06 — Text size: the shortcut zooms the whole window and saves the setting, reset returns to 1, a press on an Appearance size option sets and saves it, and a size saved through the Agent reaches the open window.
#[tokio::test]
async fn shell_app_06_text_size_zooms_the_window() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-06")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    shell.run(&["key secondary-=", "expect-scale 1.15"]).await?;
    let gw = gateway(&shell.launch);
    let saved_as = |expected: &'static str| {
        let gw = gw.clone();
        async move {
            let mut saved = gw.settings().await?["text_size"].clone();
            for _ in 0..50 {
                if saved == expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                saved = gw.settings().await?["text_size"].clone();
            }
            assert_eq!(saved, expected);
            Ok::<(), HarnessError>(())
        }
    };
    saved_as("large").await?;
    shell.run(&["key secondary-0", "expect-scale 1"]).await?;
    saved_as("default").await?;
    // The middle option of the Appearance text-size group (크게), pressed with the pointer.
    shell
        .run(&[
            "click sidebar-settings",
            "wait-anchor settings-nav-appearance",
            "click settings-nav-appearance",
            "wait-anchor text-size",
            "click-at text-size 0.45 0.5",
            "expect-scale 1.15",
        ])
        .await?;
    saved_as("large").await?;
    let patched = gw
        .patch("/settings", json!({"text_size": "larger"}))
        .await?;
    assert_eq!(patched.status, 200, "{}", patched.text);
    shell.run(&["expect-scale 1.3"]).await?;
    control_pointer_states(&mut shell, &sandbox).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

async fn control_pointer_states(shell: &mut Shell, sandbox: &Sandbox) -> Result<(), HarnessError> {
    shell
        .run(&[
            "key secondary-0",
            "expect-scale 1",
            "key escape",
            "expect-no-anchor settings-nav-appearance",
            "hover chat-card",
            "layout ctl sidebar-settings",
            "shot ctl-rest",
            "hover sidebar-settings",
            "shot ctl-hover",
            "hover chat-card",
            "shot ctl-unhover",
        ])
        .await?;
    let layout = shell.report("ctl.layout")?;
    let [bounds, neutral] = ["sidebar-settings", "chat-card"].map(|anchor| {
        let entry = layout
            .as_array()
            .expect("layout array")
            .iter()
            .find(|entry| entry["anchor"] == anchor)
            .expect("anchor bounds");
        ["x", "y", "w", "h"].map(|key| entry[key].as_f64().expect("number"))
    });
    // Two widths lands beyond the settings row, inside the empty chat area to its right.
    let (release_x, release_y) = (bounds[0] + 2.0 * bounds[2], bounds[1] + 0.5 * bounds[3]);
    assert!(
        release_x > bounds[0] + bounds[2]
            && release_x > neutral[0]
            && release_x < neutral[0] + neutral[2]
            && release_y > neutral[1]
            && release_y < neutral[1] + neutral[3],
        "release outside the control must land inside chat-card: {bounds:?}, {neutral:?}"
    );
    shell
        .run(&[
            "drag-from sidebar-settings 0.5 0.5 2.0 0.5",
            "shot ctl-released",
            "expect-no-anchor settings-nav-appearance",
        ])
        .await?;
    let shots = sandbox.root.join("shell");
    let rest = shots.join("ctl-rest.png");
    assert!(
        region_differs(&rest, &shots.join("ctl-hover.png"), bounds),
        "hover was not drawn"
    );
    assert!(
        !region_differs(&rest, &shots.join("ctl-unhover.png"), bounds),
        "hover out was not drawn"
    );
    assert!(
        !region_differs(&rest, &shots.join("ctl-released.png"), bounds),
        "control stayed pressed after release outside"
    );
    Ok(())
}

fn region_differs(a: &std::path::Path, b: &std::path::Path, bounds: [f64; 4]) -> bool {
    let (before, after) = (
        image::open(a).expect("shot").to_rgba8(),
        image::open(b).expect("shot").to_rgba8(),
    );
    assert_eq!(before.dimensions(), after.dimensions());
    let [left, top, width, height] = bounds;
    before.enumerate_pixels().any(|(col, row, pixel)| {
        let (x, y) = (f64::from(col), f64::from(row));
        x >= left
            && x < left + width
            && y >= top
            && y < top + height
            && after.get_pixel(col, row) != pixel
    })
}
