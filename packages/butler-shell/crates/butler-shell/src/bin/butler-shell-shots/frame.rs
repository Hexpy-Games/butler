//! Live frame commands exercise the same input handlers as the native window.
use super::{Harness, settle, ui};
use anyhow::{Context as _, ensure};
use gpui::{
    Focusable as _, MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput, point, px, size,
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
        "expect-anchor" | "expect-no-anchor" => {
            settle(&mut h.cx, h.handle);
            ensure!(
                h.cx.debug_bounds(h.handle, arg)?.is_some() == (command == "expect-anchor"),
                "unexpected visibility for {arg}"
            );
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

fn pointer(h: &mut Harness, command: &str, arg: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let (anchor, delta) = arg.split_once(' ').unwrap_or((arg, "0"));
    let bounds =
        h.cx.debug_bounds(h.handle, anchor)?
            .context("missing pointer target")?;
    let start = bounds.center();
    let end = point(start.x + px(delta.parse::<f32>()?), start.y);
    h.cx.update_window(h.handle, |_, w, cx| {
        w.simulate_mouse_move(start, cx);
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: start,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })?;
    settle(&mut h.cx, h.handle);
    h.cx.update_window(h.handle, |_, w, cx| {
        if command == "drag" {
            w.simulate_mouse_move(end, cx);
        }
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
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
