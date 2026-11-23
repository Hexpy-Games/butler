//! Live frame commands exercise the same input handlers as the native window.
use super::clipboard::{expect_clipboard, expect_clipboard_contains, expect_clipboard_prefix};
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
        "drag-from" => drag_from(h, arg),
        "drag-hold" => super::hold::drag_hold(h, arg),
        "drag-release" => super::hold::drag_release(h, arg),
        "click-at" => click_at(h, arg),
        "page-click" => page_click(h, arg),
        "page-hover" => page_hover(h, arg),
        "hover" => hover(h, arg),
        "wheel" => wheel(h, arg),
        "reveal" => reveal(h, arg),
        "wait-anchor" | "wait-no-anchor" => wait_anchor(h, arg, command == "wait-anchor"),
        "wait-theme" => wait_theme(h, arg),
        "expect-click-glide" => super::glide::expect_click_glide(h, arg),
        "expect-anchor" | "expect-no-anchor" => {
            settle(&mut h.cx, h.handle);
            ensure!(
                find_anchor(h, arg)?.is_some() == (command == "expect-anchor"),
                "unexpected visibility for {arg}"
            );
            Ok(())
        }
        "expect-within" => expect_within(h, arg),
        "expect-toasts" => {
            settle(&mut h.cx, h.handle);
            let expected: usize = arg.parse()?;
            let shown = h.cx.update(|cx| butler_ds::ui::toast::mounted(cx));
            ensure!(shown == expected, "{shown} toasts, expected {expected}");
            Ok(())
        }
        "expect-clipboard" => expect_clipboard(h, arg),
        "expect-clipboard-prefix" => expect_clipboard_prefix(h, arg),
        "expect-clipboard-contains" => expect_clipboard_contains(h, arg),
        "expect-scale" => expect_scale(h, arg.parse()?),
        "expect-session" => h.update(|s, _, cx| {
            assert_eq!(
                s.store.selected().map(|c| c.session.0.as_ref()),
                if arg == "new" { None } else { Some(arg) }
            );
            cx.notify();
        }),
        "expect-palette" => h.cx.update(|cx| {
            h.window.update(cx, |shell, _, cx| {
                ensure!(shell.palette().read(cx).is_open(), "palette not open");
                Ok(())
            })
        })?,
        "expect-composer-focus" => h.cx.update(|cx| {
            h.window.update(cx, |shell, window, cx| {
                ensure!(
                    shell.composer.read(cx).focus_handle(cx).is_focused(window),
                    "composer not focused"
                );
                Ok(())
            })
        })?,
        "expect-composer-menu" => expect_composer_menu(h, arg),
        "wait" => {
            h.cx.advance_clock(std::time::Duration::from_millis(arg.parse()?));
            settle(&mut h.cx, h.handle);
            Ok(())
        }
        _ => anyhow::bail!("unknown frame command"),
    }
}

fn expect_composer_menu(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let open = h.cx.update(|cx| {
        h.window
            .update(cx, |shell, _, cx| shell.composer.read(cx).menu_open())
    })?;
    ensure!(open == (arg == "open"), "composer menu open is {open}");
    Ok(())
}

/// `expect-within <inner> <outer>`: both anchors show, `inner` has a size and lies inside `outer`.
fn expect_within(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let (inner, outer) = arg
        .split_once(' ')
        .context("expect-within <inner> <outer>")?;
    let (_, a) = find_anchor(h, inner)?.with_context(|| format!("missing {inner}"))?;
    let (_, b) = find_anchor(h, outer)?.with_context(|| format!("missing {outer}"))?;
    let slack = px(0.5);
    ensure!(
        a.size.width > px(0.) && a.size.height > px(0.),
        "{inner} has no size: {a:?}"
    );
    ensure!(
        a.left() + slack >= b.left()
            && a.top() + slack >= b.top()
            && a.right() <= b.right() + slack
            && a.bottom() <= b.bottom() + slack,
        "{inner} {a:?} is not inside {outer} {b:?}"
    );
    Ok(())
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
        if find_anchor(h, anchor)?.is_some() == shown {
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

/// `expect-scale <n>`: real time passes until the DS scale and the window zoom both equal `n`
/// (a size saved through the Agent lands as a live event), for at most 30 seconds.
fn expect_scale(h: &mut Harness, scale: f32) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        settle(&mut h.cx, h.handle);
        let actual =
            h.cx.update(|cx| butler_ds::ui::context::Ds::get(cx).tokens().ui_scale);
        let zoom =
            h.cx.update(|cx| h.window.update(cx, |_, window, _| window.zoom()))?;
        if actual == scale && zoom == scale {
            return Ok(());
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "scale {actual}, zoom {zoom}, expected {scale}"
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
    wheel_at(
        h,
        h.handle,
        position,
        ScrollDelta::Pixels(point(px(0.), -delta)),
        (TouchPhase::Moved, false),
    )
}

/// `wheel <anchor> <dy> [fx fy] [started|moved|ended|momentum|lines]`: one wheel step of `dy` px
/// (positive scrolls toward the start) with the pointer at the anchor's fractions (default its
/// centre), wherever the anchor is (a popover's surface is its own layer). Without a phase word,
/// sends a phase-less mouse-wheel tick.
/// `lines` sends `dy` as mouse-wheel lines (`ScrollDelta::Lines`) instead of pixels.
fn wheel(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let mut parts: Vec<&str> = arg.split_whitespace().collect();
    let last = parts.last().copied();
    let lines = last == Some("lines");
    let phase = if lines {
        None
    } else {
        last.and_then(wheel_phase)
    };
    if lines || phase.is_some() {
        parts.pop();
    }
    let mut parts = parts.into_iter();
    let anchor = parts.next().context("wheel anchor")?;
    let dy: f32 = parts.next().context("wheel dy")?.parse()?;
    let fx: f32 = parts.next().unwrap_or("0.5").parse()?;
    let fy: f32 = parts.next().unwrap_or("0.5").parse()?;
    let (handle, bounds) = find_anchor(h, anchor)?.context("missing wheel target")?;
    let position = point(
        bounds.left() + bounds.size.width * fx,
        bounds.top() + bounds.size.height * fy,
    );
    let delta = if lines {
        ScrollDelta::Lines(point(0., dy))
    } else {
        ScrollDelta::Pixels(point(px(0.), px(dy)))
    };
    wheel_at(
        h,
        handle,
        position,
        delta,
        phase.unwrap_or((TouchPhase::Moved, false)),
    )
}

/// A trackpad phase word of `wheel`: (phase, momentum).
fn wheel_phase(word: &str) -> Option<(TouchPhase, bool)> {
    match word {
        "started" => Some((TouchPhase::Started, false)),
        "moved" => Some((TouchPhase::Moved, false)),
        "ended" => Some((TouchPhase::Ended, false)),
        "momentum" => Some((TouchPhase::Moved, true)),
        _ => None,
    }
}

/// One wheel step of `delta` with the pointer at `position` in the window `handle`, then settles.
fn wheel_at(
    h: &mut Harness,
    handle: gpui::AnyWindowHandle,
    position: gpui::Point<gpui::Pixels>,
    delta: ScrollDelta,
    (touch_phase, momentum): (TouchPhase, bool),
) -> anyhow::Result<()> {
    move_pointer(h, handle, position, None)?;
    h.cx.update_window(handle, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::ScrollWheel(ScrollWheelEvent {
                position,
                delta,
                modifiers: Default::default(),
                touch_phase,
                momentum,
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
    move_pointer(h, h.handle, bounds.center(), None)?;
    settle(&mut h.cx, h.handle);
    Ok(())
}

fn pointer(h: &mut Harness, command: &str, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let mut parts = arg.split_whitespace();
    let anchor = parts.next().context("pointer anchor")?;
    let dx = parts.next().unwrap_or("0").parse::<f32>()?;
    let dy = parts.next().unwrap_or("0").parse::<f32>()?;
    let button = pointer_button(parts.next())?;
    let (handle, bounds) = find_anchor(h, anchor)?.context("missing pointer target")?;
    let center = bounds.center();
    let end = point(center.x + px(dx), center.y + px(dy));
    let start = if command == "drag" { center } else { end };
    pointer_sequence(h, handle, start, end, button, command == "drag")
}

fn pointer_button(button: Option<&str>) -> anyhow::Result<MouseButton> {
    match button.unwrap_or("left") {
        "left" => Ok(MouseButton::Left),
        "right" => Ok(MouseButton::Right),
        _ => anyhow::bail!("pointer button must be left or right"),
    }
}

fn click_at(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let mut parts = arg.split_whitespace();
    let anchor = parts.next().context("click-at anchor")?;
    let fx: f32 = parts.next().context("click-at fx")?.parse()?;
    let fy: f32 = parts.next().context("click-at fy")?.parse()?;
    let button = pointer_button(parts.next())?;
    let bounds =
        h.cx.debug_bounds(h.handle, anchor)?
            .context("missing pointer target")?;
    let p = point(
        bounds.left() + bounds.size.width * fx,
        bounds.top() + bounds.size.height * fy,
    );
    pointer_sequence(h, h.handle, p, p, button, false)
}

/// Fractions of the anchor bounds may extend beyond the anchor.
fn drag_from(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let mut parts = arg.split_whitespace();
    let anchor = parts.next().context("drag-from anchor")?;
    let fx0: f32 = parts.next().context("drag-from fx0")?.parse()?;
    let fy0: f32 = parts.next().context("drag-from fy0")?.parse()?;
    let fx1: f32 = parts.next().context("drag-from fx1")?.parse()?;
    let fy1: f32 = parts.next().context("drag-from fy1")?.parse()?;
    let bounds =
        h.cx.debug_bounds(h.handle, anchor)?
            .context("missing pointer target")?;
    let at = |x, y| {
        point(
            bounds.left() + bounds.size.width * x,
            bounds.top() + bounds.size.height * y,
        )
    };
    pointer_sequence(
        h,
        h.handle,
        at(fx0, fy0),
        at(fx1, fy1),
        MouseButton::Left,
        true,
    )
}

fn pointer_sequence(
    h: &mut Harness,
    handle: gpui::AnyWindowHandle,
    start: gpui::Point<gpui::Pixels>,
    end: gpui::Point<gpui::Pixels>,
    button: MouseButton,
    drag: bool,
) -> anyhow::Result<()> {
    move_pointer(h, handle, start, None)?;
    settle(&mut h.cx, h.handle);
    h.cx.update_window(handle, |_, w, cx| {
        w.activate();
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
    if drag {
        for step in 1..=8 {
            let fraction = step as f32 / 8.;
            let position = point(
                start.x + (end.x - start.x) * fraction,
                start.y + (end.y - start.y) * fraction,
            );
            move_pointer(h, handle, position, Some(button))?;
            h.cx.advance_clock(std::time::Duration::from_millis(16));
            h.cx.run_until_parked();
        }
        // A real pointer can rest in the combine zone before release (the DS's 150ms dwell).
        std::thread::sleep(std::time::Duration::from_millis(200));
        h.cx.advance_clock(std::time::Duration::from_millis(200));
        h.cx.run_until_parked();
    }
    h.cx.update_window(handle, |_, w, cx| {
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

pub(super) fn move_pointer(
    h: &mut Harness,
    handle: gpui::AnyWindowHandle,
    position: gpui::Point<gpui::Pixels>,
    pressed_button: Option<MouseButton>,
) -> anyhow::Result<()> {
    h.cx.update_window(handle, |_, w, cx| {
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

pub(super) fn find_anchor(
    h: &mut Harness,
    anchor: &str,
) -> anyhow::Result<Option<(gpui::AnyWindowHandle, gpui::Bounds<gpui::Pixels>)>> {
    let windows = h.cx.update(|cx| cx.windows());
    for handle in windows {
        if let Some(bounds) = h.cx.debug_bounds(handle, anchor)? {
            return Ok(Some((handle, bounds)));
        }
    }
    Ok(None)
}
fn page_at(h: &mut Harness, arg: &str) -> anyhow::Result<gpui::Point<gpui::Pixels>> {
    settle(&mut h.cx, h.handle);
    let (x, y) = arg.split_once(' ').context("page coordinates <x> <y>")?;
    let (x, y): (f32, f32) = (x.parse()?, y.parse()?);
    let bounds =
        h.cx.debug_bounds(h.handle, "browser-page")?
            .context("missing page surface")?;
    let mut page = None;
    h.update(|_, _, cx| {
        let model = cx.global::<ui::browser::model::BrowserState>();
        page = model
            .active()
            .and_then(|id| model.tab(id))
            .map(|tab| tab.pick.viewport());
    })?;
    #[expect(clippy::cast_possible_truncation, reason = "page pixels fit f32")]
    let (w, ht) = match page {
        Some((w, ht)) if w > 0. && ht > 0. => (w as f32, ht as f32),
        _ => (f32::from(bounds.size.width), f32::from(bounds.size.height)),
    };
    let (sx, sy) = (
        f32::from(bounds.size.width) / w,
        f32::from(bounds.size.height) / ht,
    );
    Ok(bounds.origin + point(px(x * sx), px(y * sy)))
}
fn page_click(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let at = page_at(h, arg)?;
    pointer_sequence(h, h.handle, at, at, MouseButton::Left, false)
}
fn page_hover(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let at = page_at(h, arg)?;
    move_pointer(h, h.handle, at, None)?;
    settle(&mut h.cx, h.handle);
    Ok(())
}
