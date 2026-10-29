//! Headless shot harness: renders the shell through gpui's headless wgpu renderer (the same
//! shaders as the window) at the owner's scale (1x), connected to the harness fixture and
//! disconnected, light and dark. Run with
//!   cargo test -p butler-shell --release -- --ignored shots
//! and find the PNGs in BUTLER_SHELL_SHOT_DIR (default: the target directory's `shots`).
mod fixture;

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{AnyWindowHandle, AppContext as _, HeadlessAppContext, WindowHandle, px, size};

use crate::shell::{Shell, ShellOptions};
use crate::source::{ChatId, Source};
use fixture::{APPROVAL, Fixture, LONG, schedule_dialog};

fn context() -> HeadlessAppContext {
    let platform = gpui_platform::current_platform(true);
    let mut cx = HeadlessAppContext::with_platform(
        platform.text_system(),
        Arc::new(crate::assets::Assets),
        || {
            gpui_wgpu::WgpuHeadlessRenderer::new()
                .ok()
                .map(|r| Box::new(r) as Box<dyn gpui::PlatformHeadlessRenderer>)
        },
    );
    cx.set_window_scale_factor(1.);
    cx.update(|cx| {
        crate::init(cx).expect("init");
        cx.set_reduce_motion(true);
    });
    cx
}

fn open(
    cx: &mut HeadlessAppContext,
    source: Option<Rc<dyn Source>>,
    dark: bool,
) -> (WindowHandle<Shell>, AnyWindowHandle) {
    let code_font = cx.update(|cx| crate::theme::code_font(&cx.text_system().all_font_names()));
    let window = cx
        .open_window(size(px(1100.), px(720.)), |window, cx| {
            let options = ShellOptions {
                source,
                acrylic: false,
                dark: Some(dark),
                code_font,
            };
            cx.new(|cx| Shell::new(options, window, cx))
        })
        .expect("window");
    let handle: AnyWindowHandle = window.into();
    settle(cx, handle);
    (window, handle)
}

fn settle(cx: &mut HeadlessAppContext, window: AnyWindowHandle) {
    for _ in 0..12 {
        cx.advance_clock(Duration::from_millis(50));
        cx.run_until_parked();
        let _ = cx.update_window(window, |_, window, _| window.refresh());
    }
    cx.run_until_parked();
}

fn shot(cx: &mut HeadlessAppContext, window: AnyWindowHandle, name: &str) {
    settle(cx, window);
    let image = cx.capture_screenshot(window).expect("capture");
    let dir = std::env::var_os("BUTLER_SHELL_SHOT_DIR").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/shots"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir).expect("shot dir");
    let path = dir.join(format!("{name}.png"));
    image.save(&path).expect("save png");
    println!(
        "saved {} ({}x{})",
        path.display(),
        image.width(),
        image.height()
    );
}

fn update(
    cx: &mut HeadlessAppContext,
    window: WindowHandle<Shell>,
    f: impl FnOnce(&mut Shell, &mut gpui::Window, &mut gpui::Context<Shell>),
) {
    cx.update(|app| window.update(app, f)).expect("update");
}

// test-category: format-pin
#[test]
#[ignore = "renders through the headless wgpu renderer; run explicitly"]
fn shots_connected() {
    for (dark, theme) in [(false, "light"), (true, "dark")] {
        let mut cx = context();
        let (window, handle) = open(&mut cx, Some(Rc::new(Fixture)), dark);
        update(&mut cx, window, |shell, window, cx| {
            shell.open_chat(Some(ChatId(LONG.into())), window, cx);
        });
        shot(&mut cx, handle, &format!("w2-1x-{theme}-chat"));
        update(&mut cx, window, |shell, window, cx| {
            shell.open_chat(Some(ChatId(APPROVAL.into())), window, cx);
        });
        shot(&mut cx, handle, &format!("w2-1x-{theme}-approval"));
        update(&mut cx, window, |shell, window, cx| {
            shell.open_chat(None, window, cx);
            shell.open_dialog(schedule_dialog(), cx);
        });
        shot(&mut cx, handle, &format!("w2-1x-{theme}-dialog"));
    }
}

// test-category: format-pin
#[test]
#[ignore = "renders through the headless wgpu renderer; run explicitly"]
fn shots_disconnected() {
    for (dark, theme) in [(false, "light"), (true, "dark")] {
        let mut cx = context();
        let (_, handle) = open(&mut cx, None, dark);
        shot(&mut cx, handle, &format!("w2-1x-{theme}-disconnected"));
    }
}
