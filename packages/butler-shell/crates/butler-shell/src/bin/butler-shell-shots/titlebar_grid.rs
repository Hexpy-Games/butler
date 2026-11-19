//! `titlebar-grid <step> [anchor]`: a left press every `<step>` px over the top band of `anchor`
//! (default the title bar), classified by what the press did.
use super::{Harness, settle};
use anyhow::Context as _;
use butler_ds::tokens::Length;
use butler_ds::ui::context::Ds;
use gpui::{MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput, point, px};

/// Rows run from the anchor's top to the safe-area height below it (or the anchor's bottom). The
/// release lands below the band (a dropdown trigger still toggles on press). A press is `drag` when
/// it armed the window move, `control` when a control stopped it, `dead` when it propagated and
/// armed nothing. Written to `titlebar-grid.json` (`titlebar-grid-<anchor>.json` for another
/// anchor) with the bounds of the controls in the band.
pub(super) fn run(h: &mut Harness, dir: &std::path::Path, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let mut parts = arg.split_whitespace();
    let step: f32 = parts
        .next()
        .context("titlebar-grid <step> [anchor]")?
        .parse()?;
    let anchor = parts.next().unwrap_or("titlebar");
    let bar =
        h.cx.debug_bounds(h.handle, anchor)?
            .with_context(|| format!("no such anchor: {anchor}"))?;
    let safe =
        h.cx.update(|cx| Ds::get(cx).len(Length::TitlebarSafeAreaTop));
    let bottom = bar.bottom().min(bar.top() + safe);
    let release = point(bar.left(), bottom + px(step));
    let (mut drag, mut control, mut dead) = (Vec::new(), Vec::new(), Vec::new());
    let mut y = bar.top() + px(step / 2.);
    while y < bottom {
        let mut x = bar.left() + px(step / 2.);
        while x < bar.right() {
            let press = PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: point(x, y),
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            });
            let up = PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: release,
                modifiers: Default::default(),
                click_count: 1,
            });
            let (propagated, armed) = h.cx.update_window(h.handle, |_, w, cx| {
                let propagated = w.dispatch_event(press, cx).propagate;
                let armed = butler_ds::ui::window_drag::take_armed();
                w.dispatch_event(up, cx);
                (propagated, armed)
            })?;
            let at = [f32::from(x), f32::from(y)];
            match (armed, propagated) {
                (true, _) => &mut drag,
                (false, false) => &mut control,
                (false, true) => &mut dead,
            }
            .push(at);
            x += px(step);
        }
        y += px(step);
    }
    let mut bounds = serde_json::Map::new();
    for name in CONTROLS {
        if let Some(b) = h.cx.debug_bounds(h.handle, name)? {
            let edges = [b.left(), b.top(), b.right(), b.bottom()].map(f32::from);
            bounds.insert((*name).into(), serde_json::json!(edges));
        }
    }
    println!(
        "titlebar-grid {anchor}: {} drag, {} control, {} dead",
        drag.len(),
        control.len(),
        dead.len()
    );
    let report = serde_json::json!({
        "drag": drag, "control": control, "dead": dead, "controls": bounds
    });
    let name = match anchor {
        "titlebar" => "titlebar-grid.json".to_owned(),
        other => format!("titlebar-grid-{other}.json"),
    };
    std::fs::write(dir.join(name), serde_json::to_vec(&report)?)?;
    Ok(())
}

const CONTROLS: &[&str] = &[
    "sidebar-toggle",
    "session-menu-trigger",
    "session-info-toggle",
    "titlebar-browser-toggle",
    "titlebar-file-viewer-toggle",
    "wc-min",
    "wc-max",
    "wc-close",
];
