//! `butler-ds-view --live <dir>`: the live harness, driven by commands on stdin like
//! `butler-shell-shots` live mode. Each command answers `LIVE OK`; a failed one saves
//! `failure.png` and exits non-zero.
//!
//!   page <id>             open a page (the window grows to its full height)
//!   hover <n>             move the pointer onto control n (DOM order of the page)
//!   move <n>              pointer onto control n without settling (timers keep running)
//!   press <n>             pointer onto control n and the left button down, held
//!   release               the left button up
//!   click <n>             a full click on control n
//!   focus <n>             keyboard focus on control n (the ring shows)
//!   key <keystroke>       a keystroke to the focused element
//!   scroll <story> <dx> <dy>  the wheel over story n (0-based) by dx, dy px (positive: further on)
//!   wait <ms>             advance the clock
//!   expect tooltip open|closed | focused <n> | clipboard <text> | control <n> | anchor <name>
//!   shot <name>           `<page>.<name>.png`: the owning story canvas plus 64px each side
//!   quit
use std::io::{BufRead as _, Write as _};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context as _, bail};
use gpui::{
    AnyWindowHandle, Bounds, HeadlessAppContext, Keystroke, Modifiers, MouseButton, MouseDownEvent,
    MouseUpEvent, PlatformInput, Point, ScrollDelta, ScrollWheelEvent, TouchPhase, WindowHandle,
    point, px, size,
};

use crate::app::DsView;
use crate::shots::{self, Options};

/// Margin around the owning story canvas of a state shot (logical px).
const MARGIN: f32 = 64.;

struct Live {
    cx: HeadlessAppContext,
    options: Options,
    window: WindowHandle<DsView>,
    handle: AnyWindowHandle,
    page: Option<String>,
    /// Where the pointer last went (window coordinates).
    pointer: Point<gpui::Pixels>,
}

fn control_anchor(arg: &str) -> String {
    let n = arg.trim_start_matches("control-");
    format!("control-{n}")
}

impl Live {
    fn center(&mut self, arg: &str) -> anyhow::Result<Point<gpui::Pixels>> {
        let anchor = control_anchor(arg);
        let bounds = self
            .cx
            .debug_bounds(self.handle, &anchor)?
            .with_context(|| format!("no {anchor} on the page"))?;
        Ok(bounds.center())
    }

    fn settle(&mut self) {
        shots::settle(&mut self.cx, self.handle);
    }

    fn open_page(&mut self, id: &str) -> anyhow::Result<()> {
        let index = crate::pages::all()
            .iter()
            .position(|page| page.id == id)
            .with_context(|| format!("unknown page {id}"))?;
        self.cx
            .update_window(self.handle, |_, window, _| window.remove_window())?;
        let (window, handle) = shots::open(
            &mut self.cx,
            &self.options,
            self.options.height,
            self.options.lang,
        )?;
        self.cx
            .update(|app| window.update(app, |view, _, cx| view.open(index, cx)))?;
        self.settle();
        let content = self
            .cx
            .debug_bounds(handle, "page-content")?
            .map_or(self.options.height, |b| b.size.height.as_f32());
        self.cx
            .update_window(handle, |_, window, _| window.remove_window())?;
        let height = content.ceil().max(self.options.height);
        (self.window, self.handle) =
            shots::open(&mut self.cx, &self.options, height, self.options.lang)?;
        let window = self.window;
        self.cx
            .update(|app| window.update(app, |view, _, cx| view.open(index, cx)))?;
        self.settle();
        self.page = Some(id.to_owned());
        // A new window has no pointer on it yet.
        self.pointer = Point::default();
        Ok(())
    }

    fn input(&mut self, event: PlatformInput) -> anyhow::Result<()> {
        self.cx.update_window(self.handle, |_, window, cx| {
            window.dispatch_event(event, cx);
        })?;
        Ok(())
    }

    fn move_to(&mut self, position: Point<gpui::Pixels>) -> anyhow::Result<()> {
        self.pointer = position;
        self.cx.update_window(self.handle, |_, window, cx| {
            window.simulate_mouse_move(position, cx);
        })?;
        Ok(())
    }

    fn button(&mut self, down: bool) -> anyhow::Result<()> {
        let (position, modifiers) = (self.pointer, Modifiers::default());
        self.input(if down {
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position,
                modifiers,
                click_count: 1,
                first_mouse: false,
            })
        } else {
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position,
                modifiers,
                click_count: 1,
            })
        })
    }

    fn focus(&mut self, arg: &str) -> anyhow::Result<()> {
        let n: usize = arg.trim_start_matches("control-").parse()?;
        self.cx.update(|cx| {
            butler_ds::ui::context::Ds::update(cx, |ds| {
                ds.set_modality(butler_ds::ui::context::Modality::Keyboard);
            });
        });
        let handle = self
            .cx
            .update(|cx| butler_ds::ui::control::focus_handle(cx, n))
            .with_context(|| format!("control-{n} is not focusable"))?;
        self.cx
            .update_window(self.handle, |_, window, cx| window.focus(&handle, cx))?;
        // The pointer stays where it was (no event); a shot crops to the story of the control.
        self.pointer = self.center(arg)?;
        Ok(())
    }

    fn key(&mut self, keystroke: &str) -> anyhow::Result<()> {
        let parsed = Keystroke::parse(keystroke).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        // A keystroke is the key going down and coming up (Enter and Space activate on release).
        self.cx.update_window(self.handle, |_, window, cx| {
            window.dispatch_keystroke(parsed.clone(), cx);
            window.dispatch_event(
                PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke: parsed }),
                cx,
            );
        })?;
        Ok(())
    }

    /// The wheel over the middle of story `n`'s canvas, `dx`/`dy` px further along its content.
    fn scroll(&mut self, arg: &str) -> anyhow::Result<()> {
        let mut parts = arg.split_whitespace();
        let mut next = || -> anyhow::Result<f32> {
            Ok(parts.next().context("scroll <story> <dx> <dy>")?.parse()?)
        };
        let (story, dx, dy) = (next()?, next()?, next()?);
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small index"
        )]
        let story = story as usize;
        let names = self.cx.update(|app| {
            self.window
                .read(app)
                .map(DsView::story_names)
                .unwrap_or_default()
        });
        let name = names
            .get(story)
            .with_context(|| format!("no story {story}"))?;
        let at = self
            .cx
            .debug_bounds(self.handle, &format!("story-{name}"))?
            .with_context(|| format!("no canvas for story {name}"))?
            .center();
        self.move_to(at)?;
        self.input(PlatformInput::ScrollWheel(ScrollWheelEvent {
            position: at,
            delta: ScrollDelta::Pixels(point(px(-dx), px(-dy))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        }))?;
        self.wait(100);
        Ok(())
    }

    fn wait(&mut self, ms: u64) {
        let steps = (ms / 20).max(1);
        for _ in 0..steps {
            self.cx
                .advance_clock(Duration::from_millis(ms.clamp(1, 20)));
            self.cx.run_until_parked();
            let _ = self
                .cx
                .update_window(self.handle, |_, window, _| window.refresh());
        }
        self.cx.run_until_parked();
    }

    fn expect(&mut self, what: &str) -> anyhow::Result<()> {
        let (kind, arg) = what.split_once(' ').unwrap_or((what, ""));
        let ok = match kind {
            "tooltip" => {
                let shown = self.cx.update(|cx| butler_ds::ui::tooltip::shown_count(cx)) > 0;
                shown == (arg == "open")
            }
            "focused" => {
                let n: usize = arg.parse()?;
                self.cx.update(|cx| {
                    butler_ds::ui::control::focus_handle(cx, n).is_some_and(|handle| {
                        self.window
                            .update(cx, |_, window, _| handle.is_focused(window))
                            .unwrap_or(false)
                    })
                })
            }
            "clipboard" => self.cx.update(|cx| {
                cx.read_from_clipboard()
                    .and_then(|item| item.text())
                    .is_some_and(|text| text == arg)
            }),
            "control" => self
                .cx
                .debug_bounds(self.handle, &control_anchor(arg))?
                .is_some(),
            "anchor" => self.cx.debug_bounds(self.handle, arg)?.is_some(),
            _ => bail!("unknown expectation {kind}"),
        };
        anyhow::ensure!(ok, "expectation failed: {what}");
        Ok(())
    }

    /// `<page>.<name>.png`: the story canvas under the pointer plus a margin, clipped to the window.
    fn shot(&mut self, name: &str) -> anyhow::Result<()> {
        let page = self.page.clone().context("no page open")?;
        let image = self.cx.capture_screenshot(self.handle)?;
        let names = self.cx.update(|app| {
            self.window
                .read(app)
                .map(DsView::story_names)
                .unwrap_or_default()
        });
        let mut crop = None;
        for (index, story) in names.iter().enumerate() {
            let Some(b) = self
                .cx
                .debug_bounds(self.handle, &format!("story-{story}"))?
            else {
                continue;
            };
            if b.contains(&self.pointer) || crop.is_none() && self.pointer == Point::default() {
                crop = Some((index, b));
            }
        }
        let (story, bounds) = crop.context("the pointer is on no story canvas")?;
        let window = self
            .cx
            .update_window(self.handle, |_, w, _| w.viewport_size())?;
        let x0 = (bounds.origin.x.as_f32() - MARGIN).max(0.);
        let y0 = (bounds.origin.y.as_f32() - MARGIN).max(0.);
        let x1 = (bounds.right().as_f32() + MARGIN).min(window.width.as_f32());
        let y1 = (bounds.bottom().as_f32() + MARGIN).min(window.height.as_f32());
        let area = Bounds::new(point(px(x0), px(y0)), size(px(x1 - x0), px(y1 - y0)));
        let path = self.options.dir.join(format!("{page}.{name}.png"));
        shots::crop(&image, &self.options, &area, &path)?;
        std::fs::write(
            self.options.dir.join(format!("{page}.{name}.json")),
            serde_json::to_vec_pretty(
                &serde_json::json!({"crop": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, "story": story}),
            )?,
        )?;
        Ok(())
    }

    fn command(&mut self, line: &str) -> anyhow::Result<()> {
        let (command, arg) = line.split_once(' ').unwrap_or((line, ""));
        match command {
            "page" => self.open_page(arg),
            "hover" => {
                let at = self.center(arg)?;
                self.move_to(at)?;
                self.settle();
                Ok(())
            }
            "move" => {
                let at = self.center(arg)?;
                self.move_to(at)?;
                self.wait(20);
                Ok(())
            }
            "press" => {
                let at = self.center(arg)?;
                self.move_to(at)?;
                self.settle();
                self.button(true)?;
                self.wait(100);
                Ok(())
            }
            "release" => {
                self.button(false)?;
                self.settle();
                Ok(())
            }
            "click" => {
                let at = self.center(arg)?;
                self.move_to(at)?;
                self.button(true)?;
                self.button(false)?;
                self.settle();
                Ok(())
            }
            "focus" => {
                self.focus(arg)?;
                self.settle();
                Ok(())
            }
            "key" => {
                self.key(arg)?;
                self.settle();
                Ok(())
            }
            "wait" => {
                self.wait(arg.parse()?);
                Ok(())
            }
            "scroll" => self.scroll(arg),
            "expect" => self.expect(arg),
            "shot" => self.shot(arg),
            _ => bail!("unknown live command"),
        }
    }
}

fn run(options: Options) -> anyhow::Result<()> {
    std::fs::create_dir_all(&options.dir)?;
    let mut cx = shots::context(&options)?;
    let (window, handle) = shots::open(&mut cx, &options, options.height, options.lang)?;
    let mut live = Live {
        cx,
        options,
        window,
        handle,
        page: None,
        pointer: Point::default(),
    };
    println!("LIVE READY");
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line == "quit" {
            return Ok(());
        }
        if let Err(error) = live.command(&line) {
            if let Ok(image) = live.cx.capture_screenshot(live.handle) {
                let _ = image.save(live.options.dir.join("failure.png"));
            }
            return Err(error).with_context(|| format!("command {line}"));
        }
        println!("LIVE OK");
        std::io::stdout().flush()?;
    }
    Ok(())
}

pub(crate) fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().collect();
    match Options::parse(&args, "--live").and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("butler-ds-view: {error:#}");
            ExitCode::FAILURE
        }
    }
}
