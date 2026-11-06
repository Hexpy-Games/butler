//! `butler-ds-view --live <dir>`: the live harness, driven by commands on stdin like
//! `butler-shell-shots` live mode. Each command answers `LIVE OK`; a failed one saves
//! `failure.png` and exits non-zero.
//!
//!   page <id>             open a page (the window grows to its full height, unless `viewport` set one)
//!   viewport <h>          later pages open at this window height, scrolling inside it (0: grow again)
//!   scrollto <story> <top>  scroll the page so story n's canvas top is `top` px from the window top
//!   hover <n>             move the pointer onto control n (DOM order of the page); `@name` is an
//!                         anchor of the page instead (a menu item: `@dm-session-item-0-1`), and
//!                         `@name+dx,dy` a point that far from its centre
//!   move <n>              pointer onto control n without settling (timers keep running)
//!   press <n>             pointer onto control n and the left button down, held
//!   hold <n>              like `press` without settling (the press motion in flight; use `wait`)
//!   release               the left button up (everything it starts settles)
//!   park                  the pointer to the window's top-left corner (no hover left behind)
//!   letgo                 the left button up, the motion it starts still in flight (use `wait`)
//!   dragby <dy> <ms> [dx] the held pointer travels dy px over ms (a sheet's drag; its flick speed)
//!   keyboard-inset <px>   the on-screen keyboard's height, which lifts an open sheet
//!   click <n>             a full click on control n
//!   tap <n>               a click on control n without settling (motion in flight; use `wait`)
//!   right <story> <dx> <dy>  a right click `dx`, `dy` px inside story n's canvas
//!   focus <n>             keyboard focus on control n (the ring shows)
//!   key <keystroke>       a keystroke to the focused element
//!   scroll <story> <dx> <dy>  the wheel over story n (0-based) by dx, dy px (positive: further on)
//!   type <text>           text typed into the focused field (its input handler's `replace_text_in_range`)
//!   ime-mark <text>       IME composition: `replace_and_mark_text_in_range` (the marked text, underlined)
//!   ime-commit <text>     IME commit: `replace_text_in_range` over the marked text
//!   wait <ms>             advance the clock
//!   mark <name>           remember where anchor `name` is (for `expect unmoved`)
//!   expect tooltip open|closed | focused <n> | clipboard <text> | control <n> | anchor <name>
//!         | no-anchor <name> | layers <n> | modal open|closed | unmoved <name> | moved <name>
//!         | shifted <name> <dy> [tol]  (the anchor's top is `dy` px below where `mark` saw it)
//!   shot <name> [margin]  `<page>.<name>.png`: the owning story canvas plus `margin` (64) px each side
//!   window <name>         `<page>.<name>.window.png`: the whole window
//!   quit
use std::io::{BufRead as _, Write as _};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context as _, bail};
use gpui::{
    AnyWindowHandle, Bounds, EntityInputHandler as _, HeadlessAppContext, Keystroke, Modifiers,
    MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput, Point, WindowHandle, point, px, size,
};

use crate::app::DsView;
use crate::shots::{self, Options};

/// Margin around the owning story canvas of a state shot (logical px).
pub(crate) const MARGIN: f32 = 64.;

mod drag;
mod menu;
mod scroll;

struct Live {
    cx: HeadlessAppContext,
    options: Options,
    window: WindowHandle<DsView>,
    handle: AnyWindowHandle,
    page: Option<String>,
    /// Where the pointer last went (window coordinates).
    pointer: Point<gpui::Pixels>,
    /// A window height that pages keep instead of growing to their content.
    fixed_height: Option<f32>,
    /// The story the pointer last pointed at: a shot of an overlay that opens outside every
    /// canvas crops around it.
    owner: Option<usize>,
    /// Anchor positions remembered by `mark`.
    marks: std::collections::HashMap<String, Bounds<gpui::Pixels>>,
}

fn control_anchor(arg: &str) -> String {
    let n = arg.trim_start_matches("control-");
    format!("control-{n}")
}

impl Live {
    fn center(&mut self, arg: &str) -> anyhow::Result<Point<gpui::Pixels>> {
        let (arg, offset) = arg.split_once('+').unwrap_or((arg, "0,0"));
        let (dx, dy) = offset.split_once(',').context("@name+dx,dy")?;
        let anchor = match arg.strip_prefix('@') {
            Some(name) => name.to_owned(),
            None => control_anchor(arg),
        };
        let bounds = self
            .cx
            .debug_bounds(self.handle, &anchor)?
            .with_context(|| format!("no {anchor} on the page"))?;
        Ok(bounds.center() + point(px(dx.parse()?), px(dy.parse()?)))
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
        let height = self
            .fixed_height
            .unwrap_or_else(|| content.ceil().max(self.options.height));
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

    /// Drives the focused field's `EntityInputHandler`, as the platform's IME does: `mark`
    /// composes `text` (marked, caret at its end), otherwise `text` replaces the marked text
    /// (or the selection), which ends the composition.
    fn compose(&mut self, text: &str, mark: bool) -> anyhow::Result<()> {
        self.cx.update_window(self.handle, |_, window, cx| {
            let state =
                butler_ds::ui::text::focused(window, cx).context("no focused text field")?;
            state.update(cx, |state, cx| {
                if mark {
                    let end = text.encode_utf16().count();
                    state.replace_and_mark_text_in_range(None, text, Some(end..end), window, cx);
                } else {
                    state.replace_text_in_range(None, text, window, cx);
                }
            });
            Ok(())
        })?
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
            "no-anchor" => self.cx.debug_bounds(self.handle, arg)?.is_none(),
            "shifted" => self.shifted(arg),
            "unmoved" | "moved" => {
                let now = self.cx.debug_bounds(self.handle, arg)?;
                let same = now.is_some() && now == self.marks.get(arg).copied();
                same == (kind == "unmoved")
            }
            "layers" => {
                let n: usize = arg.parse()?;
                self.cx
                    .update(|cx| butler_ds::ui::overlay::dismiss::count(cx))
                    == n
            }
            "modal" => {
                let open = self
                    .cx
                    .update(|cx| butler_ds::ui::overlay::dismiss::modal_open(cx));
                open == (arg == "open")
            }
            _ => bail!("unknown expectation {kind}"),
        };
        anyhow::ensure!(ok, "expectation failed: {what}");
        Ok(())
    }

    /// `<page>.<name>.png`: the story canvas under the pointer plus a margin, clipped to the window.
    fn shot(&mut self, name: &str, margin: f32) -> anyhow::Result<()> {
        let page = self.page.clone().context("no page open")?;
        let image = self.cx.capture_screenshot(self.handle)?;
        let names = self.cx.update(|app| {
            self.window
                .read(app)
                .map(DsView::story_names)
                .unwrap_or_default()
        });
        let (story, bounds) = self.story_of_pointer(&names)?;
        let window = self
            .cx
            .update_window(self.handle, |_, w, _| w.viewport_size())?;
        let x0 = (bounds.origin.x.as_f32() - margin).max(0.);
        let y0 = (bounds.origin.y.as_f32() - margin).max(0.);
        let x1 = (bounds.right().as_f32() + margin).min(window.width.as_f32());
        let y1 = (bounds.bottom().as_f32() + margin).min(window.height.as_f32());
        let area = Bounds::new(point(px(x0), px(y0)), size(px(x1 - x0), px(y1 - y0)));
        let path = self.options.dir.join(format!("{page}.{name}.png"));
        shots::crop(&image, &self.options, &area, &path)?;
        let overlay = self.overlay_json()?;
        std::fs::write(
            self.options.dir.join(format!("{page}.{name}.json")),
            serde_json::to_vec_pretty(
                &serde_json::json!({"crop": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, "story": story, "canvas": {"x": bounds.origin.x.as_f32(), "y": bounds.origin.y.as_f32(), "w": bounds.size.width.as_f32(), "h": bounds.size.height.as_f32()}, "overlay": overlay}),
            )?,
        )?;
        Ok(())
    }

    fn command(&mut self, line: &str) -> anyhow::Result<()> {
        let result = self.run(line);
        self.remember_owner();
        result
    }

    fn run(&mut self, line: &str) -> anyhow::Result<()> {
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
            "click" => {
                let at = self.center(arg)?;
                self.move_to(at)?;
                self.button(true)?;
                self.button(false)?;
                self.settle();
                Ok(())
            }
            "tap" => {
                let at = self.center(arg)?;
                self.move_to(at)?;
                self.button(true)?;
                self.button(false)?;
                self.wait(1);
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
            "press" => self.press(arg),
            "hold" => self.hold(arg),
            "release" => self.release(),
            "park" => self.park(),
            "letgo" => self.let_go(),
            "right" => self.right_click(arg),
            "dragby" => self.drag_by(arg),
            "dragto" => self.drag_to(arg),
            "keyboard-inset" => self.keyboard_inset(arg),
            "mark" => self.mark(arg),
            "scroll" => self.scroll(arg),
            "scrollto" => self.scroll_to(arg),
            "viewport" => {
                let height: f32 = arg.parse()?;
                self.fixed_height = (height > 0.).then_some(height);
                Ok(())
            }
            "type" | "ime-mark" | "ime-commit" => {
                self.compose(arg, command == "ime-mark")?;
                self.settle();
                Ok(())
            }
            "expect" => self.expect(arg),
            "shot" => self.shot_command(arg),
            "window" => self.window_shot(arg),
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
        fixed_height: None,
        owner: None,
        marks: std::collections::HashMap::new(),
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
