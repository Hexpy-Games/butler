//! butler-shell-shots: renders the shell headlessly through gpui's wgpu renderer (the same
//! shaders as the window) at the owner's scale (1x), connected to an in-memory fixture and
//! disconnected, in light and dark, and writes one PNG per state. The W5 smoke drives it:
//!
//!   cargo run --release -p butler-shell --features shots --bin butler-shell-shots -- <dir>
//!
//! It exits non-zero when a state cannot be rendered or saved.
#![allow(
    dead_code,
    unfulfilled_lint_expectations,
    reason = "the harness drives part of the app, whose own build uses the rest"
)]

#[path = "../../ui/mod.rs"]
mod ui;

mod fixture;
mod live;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use gpui::{AnyWindowHandle, AppContext as _, HeadlessAppContext, WindowHandle, px, size};

use ui::i18n::Locale;
use ui::shell::{Shell, ShellOptions};
use ui::source::Source;

fn context() -> anyhow::Result<HeadlessAppContext> {
    let platform = gpui_platform::current_platform(true);
    let mut cx = HeadlessAppContext::with_platform(
        platform.text_system(),
        Arc::new(ui::assets::Assets),
        || {
            gpui_wgpu::WgpuHeadlessRenderer::new()
                .ok()
                .map(|r| Box::new(r) as Box<dyn gpui::PlatformHeadlessRenderer>)
        },
    );
    cx.set_window_scale_factor(1.);
    cx.update(|cx| {
        cx.set_reduce_motion(true);
        ui::init(cx)
    })?;
    Ok(cx)
}

fn settle(cx: &mut HeadlessAppContext, window: AnyWindowHandle) {
    for _ in 0..12 {
        cx.advance_clock(Duration::from_millis(50));
        cx.run_until_parked();
        let _ = cx.update_window(window, |_, window, _| window.refresh());
    }
    cx.run_until_parked();
}

struct Harness {
    cx: HeadlessAppContext,
    window: WindowHandle<Shell>,
    handle: AnyWindowHandle,
}

impl Harness {
    fn open(source: Option<Rc<dyn Source>>, dark: bool) -> anyhow::Result<Self> {
        let mut cx = context()?;
        let code_font = cx.update(|cx| ui::theme::code_font(&cx.text_system().all_font_names()));
        let window = cx.open_window(size(px(800.), px(720.)), |window, cx| {
            let options = ShellOptions {
                source,
                acrylic: false,
                dark: Some(dark),
                code_font,
                locale: Locale::Ko,
            };
            cx.new(|cx| Shell::new(options, window, cx))
        })?;
        let handle: AnyWindowHandle = window.into();
        settle(&mut cx, handle);
        Ok(Self { cx, window, handle })
    }

    fn update(
        &mut self,
        f: impl FnOnce(&mut Shell, &mut gpui::Window, &mut gpui::Context<Shell>),
    ) -> anyhow::Result<()> {
        self.cx.update(|app| self.window.update(app, f))
    }

    fn shot(&mut self, dir: &Path, name: &str) -> anyhow::Result<()> {
        settle(&mut self.cx, self.handle);
        let image = self.cx.capture_screenshot(self.handle)?;
        let path = dir.join(format!("{name}.png"));
        image
            .save(&path)
            .with_context(|| format!("saving {}", path.display()))?;
        println!(
            "saved {} ({}x{})",
            path.display(),
            image.width(),
            image.height()
        );
        Ok(())
    }
}

/// Opens `chat` from the fixture.
fn open_chat(
    shell: &mut Shell,
    chat: &str,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<Shell>,
) {
    let chat = shell
        .store
        .chats
        .iter()
        .find(|c| c.chat.chat.0.as_ref() == chat)
        .map(|c| c.chat.clone());
    shell.open_chat(chat, window, cx);
}

fn connected(dir: &Path, dark: bool, theme: &str) -> anyhow::Result<()> {
    let mut h = Harness::open(Some(Rc::new(fixture::Fixture)), dark)?;
    h.update(|shell, window, cx| open_chat(shell, fixture::LONG, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-chat"))?;
    h.update(|shell, window, cx| open_chat(shell, fixture::APPROVAL, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-approval"))?;
    h.update(|shell, window, cx| {
        if let Some(card) = shell.store.approval().cloned() {
            shell.open_modify(&card, window, cx);
        }
    })?;
    h.shot(dir, &format!("w2-1x-{theme}-modify-dialog"))?;
    h.update(|shell, window, cx| open_chat(shell, fixture::QUESTION, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-question"))?;
    h.update(|shell, window, cx| shell.open_chat(None, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-new-chat"))
}

fn disconnected(dir: &Path, dark: bool, theme: &str) -> anyhow::Result<()> {
    let mut h = Harness::open(None, dark)?;
    h.shot(dir, &format!("w2-1x-{theme}-disconnected"))
}

fn run(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    for (dark, theme) in [(false, "light"), (true, "dark")] {
        connected(dir, dark, theme)?;
        disconnected(dir, dark, theme)?;
    }
    Ok(())
}

fn main() -> ExitCode {
    let dir = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("usage: butler-shell-shots <dir>"));
    let args: Vec<_> = std::env::args_os().collect();
    let data = args
        .windows(2)
        .find(|p| p[0] == "--data")
        .map(|p| PathBuf::from(&p[1]));
    let dark = args.iter().any(|a| a == "--dark");
    match dir.and_then(|dir| match data {
        Some(data) => live::run(&dir, data, dark),
        None => run(&dir),
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("butler-shell-shots: {error:#}");
            ExitCode::FAILURE
        }
    }
}
