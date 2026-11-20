//! The title band as a window drag region, through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-12 — Electron's `app-region` rule: the title band drags except its controls, which
/// take the press. Presses on a grid over the band (the harness's `titlebar-grid`) are checked
/// against the controls' bounds: every press inside a control is stopped, and the band itself drags
/// (the band above the open sidebar too; a press counts as drag only if it armed the move).
#[tokio::test]
async fn shell_app_12_the_title_band_drags_except_its_controls() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-12")?;
    let _model = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let created = gateway(&shell.launch)
        .post("/sessions", json!({"kind": "chat", "title": "Band"}))
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
            "wait-anchor session-menu-trigger",
            // Sidebar open: the band above it drags too.
            "titlebar-grid 8 sidebar",
        ])
        .await?;
    check(&shell.report("titlebar-grid-sidebar")?);
    shell
        .run(&[
            // Sidebar collapsed: the title band then spans the window, the sidebar toggle in it.
            "click sidebar-toggle",
            "wait 500",
            "titlebar-grid 8",
        ])
        .await?;
    check(&shell.report("titlebar-grid")?);
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// The grid's assertions: no press that armed the move lies inside a control, no press outside the
/// controls is dead, and some press arms the move.
fn check(grid: &serde_json::Value) {
    let points = |key: &str| -> Vec<(f64, f64)> {
        grid[key]
            .as_array()
            .expect("points")
            .iter()
            .map(|p| (p[0].as_f64().expect("x"), p[1].as_f64().expect("y")))
            .collect()
    };
    let controls: Vec<Vec<f64>> = grid["controls"]
        .as_object()
        .expect("controls")
        .values()
        .map(|b| {
            b.as_array()
                .expect("bounds")
                .iter()
                .map(|e| e.as_f64().expect("edge"))
                .collect()
        })
        .collect();
    let inside = |(x, y): (f64, f64)| {
        controls
            .iter()
            .any(|b| x >= b[0] && x < b[2] && y >= b[1] && y < b[3])
    };
    let drag = points("drag");
    let from_control: Vec<_> = drag.iter().filter(|p| inside(**p)).collect();
    assert!(
        from_control.is_empty(),
        "presses on a control reach the window drag: {from_control:?}\n{grid}"
    );
    let dead: Vec<_> = points("dead").into_iter().filter(|p| !inside(*p)).collect();
    assert!(
        dead.is_empty(),
        "presses outside the controls move nothing: {dead:?}\n{grid}"
    );
    assert!(!drag.is_empty(), "no press arms the window drag\n{grid}");
}
