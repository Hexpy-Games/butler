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
mod frame;
mod live;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use gpui::{AnyWindowHandle, AppContext as _, HeadlessAppContext, WindowHandle, px, size};

use ui::i18n::Locale;
use ui::shell::{Shell, ShellOptions};
use ui::source::Source;
use ui::theme::Platform;

fn context(scale: f32) -> anyhow::Result<HeadlessAppContext> {
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
    cx.set_window_scale_factor(scale);
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

impl Drop for Harness {
    /// `window.activate()` makes the headless platform keep the window (its `active_window`)
    /// past `HeadlessAppContext`'s shutdown, and the window's platform input handler holds a
    /// strong `Entity<EditableTextState>` while a field is focused. Leak detection would report
    /// that handle as leaked. A drawn frame without a focused field replaces the handler.
    fn drop(&mut self) {
        let _ = self.update(|shell, window, cx| window.focus(&shell.focus_handle(), cx));
        settle(&mut self.cx, self.handle);
    }
}

impl Harness {
    fn open(source: Option<Rc<dyn Source>>, dark: bool, options: &Options) -> anyhow::Result<Self> {
        let mut cx = context(options.scale)?;
        let code_font = cx.update(|cx| ui::theme::code_font(&cx.text_system().all_font_names()));
        let window =
            cx.open_window(size(px(options.width), px(options.height)), |window, cx| {
                let options = ShellOptions {
                    source,
                    dark: Some(dark),
                    code_font,
                    locale: Locale::Ko,
                    platform: options.platform,
                };
                cx.new(|cx| Shell::new(options, window, cx))
            })?;
        cx.update(|cx| {
            window.update(cx, |shell, window, cx| {
                window.activate();
                window.focus(&shell.focus_handle(), cx);
            })
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

    fn layout(&mut self, dir: &Path, name: &str) -> anyhow::Result<()> {
        let mut arguments = name.split_whitespace();
        let name = arguments.next().context("layout <name> [anchors…]")?;
        settle(&mut self.cx, self.handle);
        let mut anchors = self.cx.update(|app| {
            self.window.read(app).map(|s| {
                let mut names = vec![
                    "sidebar",
                    "chat-card",
                    "composer",
                    "composer-field",
                    "send-button",
                    "approval-card",
                    "question-card",
                    "titlebar",
                    "session-info-toggle",
                    "inspector",
                    "artifact-tile-0",
                    "file-viewer",
                    "file-viewer-header",
                    "file-viewer-page",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
                names.extend(
                    s.store
                        .chats
                        .iter()
                        .map(|c| format!("sidebar-row-{}", c.chat.chat.0)),
                );
                names.extend(
                    s.store
                        .shown_view()
                        .iter()
                        .flat_map(|view| view.messages.iter())
                        .map(|m| format!("message-{}", m.id)),
                );
                names
            })
        })?;
        anchors.extend(arguments.map(str::to_owned));
        anchors.sort();
        anchors.dedup();
        let mut layout = Vec::new();
        for anchor in anchors {
            if let Some(b) = self.cx.debug_bounds(self.handle, &anchor)? {
                layout.push(serde_json::json!({"anchor": anchor, "x": b.origin.x.as_f32(),
                    "y": b.origin.y.as_f32(), "w": b.size.width.as_f32(), "h": b.size.height.as_f32()}));
            }
        }
        std::fs::write(
            dir.join(format!("{name}.layout.json")),
            serde_json::to_vec_pretty(&layout)?,
        )?;
        Ok(())
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

fn connected(dir: &Path, dark: bool, theme: &str, options: &Options) -> anyhow::Result<()> {
    let mut h = Harness::open(Some(Rc::new(fixture::Fixture)), dark, options)?;
    h.update(|shell, window, cx| open_chat(shell, fixture::LONG, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-chat"))?;
    h.update(|shell, window, cx| open_chat(shell, fixture::APPROVAL, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-approval"))?;
    h.update(|shell, window, cx| open_chat(shell, fixture::QUESTION, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-question"))?;
    h.update(|shell, window, cx| shell.open_chat(None, window, cx))?;
    h.shot(dir, &format!("w2-1x-{theme}-new-chat"))
}

fn disconnected(dir: &Path, dark: bool, theme: &str, options: &Options) -> anyhow::Result<()> {
    let mut h = Harness::open(None, dark, options)?;
    h.shot(dir, &format!("w2-1x-{theme}-disconnected"))
}

fn run(dir: &Path, options: &Options) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    for (dark, theme) in [(false, "light"), (true, "dark")] {
        connected(dir, dark, theme, options)?;
        disconnected(dir, dark, theme, options)?;
    }
    Ok(())
}

struct Options {
    scale: f32,
    width: f32,
    height: f32,
    platform: Platform,
}

impl Options {
    fn parse(args: &[std::ffi::OsString]) -> anyhow::Result<Self> {
        let value = |flag: &str| {
            args.windows(2)
                .find(|p| p[0] == flag)
                .map(|p| p[1].to_str().context("arguments must be UTF-8"))
                .transpose()
        };
        let scale = value("--scale")?.unwrap_or("1").parse::<f32>()?;
        let (width, height) = value("--size")?
            .unwrap_or("800x720")
            .split_once('x')
            .context("--size requires <W>x<H>")?;
        let (width, height) = (width.parse::<f32>()?, height.parse::<f32>()?);
        let platform = match value("--platform")? {
            None => Platform::host(),
            Some("mac") => Platform::Mac,
            Some("windows") => Platform::Windows,
            Some("linux") => Platform::Linux,
            Some(_) => anyhow::bail!("--platform requires mac|windows|linux"),
        };
        anyhow::ensure!(
            [scale, width, height]
                .iter()
                .all(|v| v.is_finite() && *v > 0.),
            "scale and dimensions must be finite and positive"
        );
        Ok(Self {
            scale,
            width,
            height,
            platform,
        })
    }
}

fn main() -> ExitCode {
    let result = (|| {
        let args: Vec<_> = std::env::args_os().collect();
        let dir = args.get(1).map(PathBuf::from).context(
            "usage: butler-shell-shots <dir> [--data <dir>] [--scale <f32>] [--size <W>x<H>] [--platform mac|windows|linux]",
        )?;
        let options = Options::parse(&args)?;
        let data = args
            .windows(2)
            .find(|p| p[0] == "--data")
            .map(|p| PathBuf::from(&p[1]));
        let dark = args.iter().any(|a| a == "--dark");
        match data {
            Some(data) => live::run(&dir, data, dark, &options),
            None => run(&dir, &options),
        }
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("butler-shell-shots: {error:#}");
            ExitCode::FAILURE
        }
    }
}
