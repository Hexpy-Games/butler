//! Live frame commands exercise the same input handlers as the native window.
use super::{Harness, settle, ui};
use anyhow::{Context as _, ensure};
use gpui::{
    Focusable as _, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput,
    ScrollDelta, ScrollWheelEvent, TouchPhase, point, px, size,
};

pub(super) fn command(h: &mut Harness, command: &str, arg: &str) -> anyhow::Result<()> {
    match command {
        "url" => h.update(|s, w, cx| {
            if let Some(request) = ui::shell::navigation::Navigation::from_url(arg) {
                s.navigate(request, w, cx);
            }
        }),
        "size" => {
            let (w, v) = arg.split_once(' ').context("size <width> <height>")?;
            let (w, v) = (w.parse::<f32>()?, v.parse::<f32>()?);
            h.cx.update_window(h.handle, |_, window, cx| {
                window.resize(size(px(w), px(v)));
                window.bounds_changed(cx);
            })
        }
        "click" | "drag" => pointer(h, command, arg),
        "hover" => hover(h, arg),
        "reveal" => reveal(h, arg),
        "wait-anchor" | "wait-no-anchor" => wait_anchor(h, arg, command == "wait-anchor"),
        "wait-theme" => wait_theme(h, arg),
        "expect-anchor" | "expect-no-anchor" => {
            settle(&mut h.cx, h.handle);
            ensure!(
                h.cx.debug_bounds(h.handle, arg)?.is_some() == (command == "expect-anchor"),
                "unexpected visibility for {arg}"
            );
            Ok(())
        }
        "expect-toasts" => {
            settle(&mut h.cx, h.handle);
            let expected: usize = arg.parse()?;
            let shown = h.cx.update(|cx| butler_ds::ui::toast::mounted(cx));
            ensure!(shown == expected, "{shown} toasts, expected {expected}");
            Ok(())
        }
        "expect-scale" => {
            let scale: f32 = arg.parse()?;
            let actual =
                h.cx.update(|cx| butler_ds::ui::context::Ds::get(cx).tokens().ui_scale);
            ensure!(actual == scale, "scale {actual}, expected {scale}");
            Ok(())
        }
        "expect-session" => h.update(|s, _, cx| {
            assert_eq!(
                s.store.selected().map(|c| c.session.0.as_ref()),
                if arg == "new" { None } else { Some(arg) }
            );
            cx.notify();
        }),
        "expect-composer-focus" => h.cx.update(|cx| {
            h.window.update(cx, |shell, window, cx| {
                ensure!(
                    shell.composer.read(cx).focus_handle(cx).is_focused(window),
                    "composer not focused"
                );
                Ok(())
            })
        })?,
        "wait" => {
            h.cx.advance_clock(std::time::Duration::from_millis(arg.parse()?));
            settle(&mut h.cx, h.handle);
            Ok(())
        }
        _ => anyhow::bail!("unknown frame command"),
    }
}

/// `expect-fresh`: the frame drawn from notifications alone equals a full re-render. A region
/// left stale by a missed notify differs once `window.refresh()` redraws everything; both
/// frames are saved when they differ.
pub(super) fn expect_fresh(h: &mut Harness, dir: &std::path::Path) -> anyhow::Result<()> {
    for _ in 0..4 {
        h.cx.advance_clock(std::time::Duration::from_millis(50));
        h.cx.run_until_parked();
    }
    let notified = h.cx.capture_screenshot(h.handle)?;
    h.cx.update_window(h.handle, |_, window, _| window.refresh())?;
    h.cx.run_until_parked();
    let refreshed = h.cx.capture_screenshot(h.handle)?;
    if notified.as_raw() != refreshed.as_raw() {
        notified.save(dir.join("stale-notified.png"))?;
        refreshed.save(dir.join("stale-refreshed.png"))?;
        anyhow::bail!("the notified frame differs from a full re-render");
    }
    Ok(())
}

/// `wait-anchor <anchor>` / `wait-no-anchor <anchor>`: real time passes until the anchor shows
/// or goes (it may wait on an agent answer), for at most 30 seconds (the Electron side's wait).
fn wait_anchor(h: &mut Harness, anchor: &str, shown: bool) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        settle(&mut h.cx, h.handle);
        if h.cx.debug_bounds(h.handle, anchor)?.is_some() == shown {
            return Ok(());
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "anchor {anchor} did not {}",
            if shown { "show" } else { "go" }
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// `wait-theme <light|dark>`: real time passes until the shell shows that theme (a Settings
/// save lands through the Agent), for at most 30 seconds.
fn wait_theme(h: &mut Harness, theme: &str) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        settle(&mut h.cx, h.handle);
        if h.cx.update(|cx| h.window.read(cx).map(|s| s.theme.dark))? == (theme == "dark") {
            return Ok(());
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "theme {theme} did not show"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// `reveal <anchor> <port>`: scrolls `port` (a scroll port) so the anchor's centre sits at the
/// port's centre, as far as the port scrolls: Electron's click runs
/// `scrollIntoView({block: "center"})` first. One wheel step over the port does it.
fn reveal(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let (anchor, port) = arg.split_once(' ').context("reveal <anchor> <port>")?;
    let target =
        h.cx.debug_bounds(h.handle, anchor)?
            .context("missing reveal target")?;
    let port =
        h.cx.debug_bounds(h.handle, port)?
            .context("missing scroll port")?;
    let position = port.center();
    let delta = target.center().y - position.y;
    move_pointer(h, position, None)?;
    h.cx.update_window(h.handle, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::ScrollWheel(ScrollWheelEvent {
                position,
                delta: ScrollDelta::Pixels(point(px(0.), -delta)),
                modifiers: Default::default(),
                touch_phase: TouchPhase::Moved,
            }),
            cx,
        );
    })?;
    settle(&mut h.cx, h.handle);
    Ok(())
}

/// `hover <anchor>`: rests the pointer on the anchor's centre, as a user does to reveal hover-only controls.
fn hover(h: &mut Harness, anchor: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let bounds =
        h.cx.debug_bounds(h.handle, anchor)?
            .context("missing hover target")?;
    move_pointer(h, bounds.center(), None)?;
    settle(&mut h.cx, h.handle);
    Ok(())
}

fn pointer(h: &mut Harness, command: &str, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let mut parts = arg.split_whitespace();
    let anchor = parts.next().context("pointer anchor")?;
    let dx = parts.next().unwrap_or("0").parse::<f32>()?;
    let dy = parts.next().unwrap_or("0").parse::<f32>()?;
    let button = match parts.next().unwrap_or("left") {
        "left" => MouseButton::Left,
        "right" => MouseButton::Right,
        _ => anyhow::bail!("pointer button must be left or right"),
    };
    let bounds =
        h.cx.debug_bounds(h.handle, anchor)?
            .context("missing pointer target")?;
    let center = bounds.center();
    let end = point(center.x + px(dx), center.y + px(dy));
    let start = if command == "drag" { center } else { end };
    move_pointer(h, start, None)?;
    settle(&mut h.cx, h.handle);
    h.cx.update_window(h.handle, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                button,
                position: start,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })?;
    h.cx.run_until_parked();
    if command == "drag" {
        for step in 1..=8 {
            let fraction = step as f32 / 8.;
            let position = point(
                start.x + (end.x - start.x) * fraction,
                start.y + (end.y - start.y) * fraction,
            );
            move_pointer(h, position, Some(button))?;
            h.cx.advance_clock(std::time::Duration::from_millis(16));
            h.cx.run_until_parked();
        }
        // A real pointer can rest in the combine zone before release (the DS's 150ms dwell).
        std::thread::sleep(std::time::Duration::from_millis(200));
        h.cx.advance_clock(std::time::Duration::from_millis(200));
        h.cx.run_until_parked();
    }
    h.cx.update_window(h.handle, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                button,
                position: end,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
    })?;
    settle(&mut h.cx, h.handle);
    Ok(())
}

fn move_pointer(
    h: &mut Harness,
    position: gpui::Point<gpui::Pixels>,
    pressed_button: Option<MouseButton>,
) -> anyhow::Result<()> {
    h.cx.update_window(h.handle, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position,
                modifiers: Default::default(),
                pressed_button,
            }),
            cx,
        );
    })
}
