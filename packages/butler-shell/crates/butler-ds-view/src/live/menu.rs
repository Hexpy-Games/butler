//! The overlay commands of the live harness: the right click of a context menu, and the shot's
//! choice of story and overlay geometry.
use anyhow::Context as _;
use gpui::{Bounds, MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput, Point, point, px};

use super::Live;
use crate::app::DsView;

/// The surfaces a shot reports the geometry of, outermost first (`debug_selector` names).
const SURFACES: [&str; 6] = [
    "popover-content",
    "menu-content",
    "select-content",
    "menu-sub-content",
    "dialog-content",
    "toast-front",
];

impl Live {
    /// The names of the open page's stories.
    fn names(&mut self) -> Vec<String> {
        self.cx.update(|app| {
            self.window
                .read(app)
                .map(DsView::story_names)
                .unwrap_or_default()
        })
    }

    fn canvas(&mut self, index: usize, names: &[String]) -> anyhow::Result<Bounds<gpui::Pixels>> {
        let name = names
            .get(index)
            .with_context(|| format!("no story {index}"))?;
        self.cx
            .debug_bounds(self.handle, &format!("story-{name}"))?
            .with_context(|| format!("no canvas for story {name}"))
    }

    /// `right <story> <dx> <dy>`: a right click `dx`, `dy` px inside the story's canvas.
    pub(super) fn right_click(&mut self, arg: &str) -> anyhow::Result<()> {
        let mut parts = arg.split_whitespace();
        let mut next = || -> anyhow::Result<f32> {
            Ok(parts.next().context("right <story> <dx> <dy>")?.parse()?)
        };
        let (story, dx, dy) = (next()?, next()?, next()?);
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small index"
        )]
        let story = story as usize;
        let names = self.names();
        let origin = self.canvas(story, &names)?.origin;
        let at = point(origin.x + px(dx), origin.y + px(dy));
        self.move_to(at)?;
        for down in [true, false] {
            let event = if down {
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Right,
                    position: at,
                    modifiers: gpui::Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                })
            } else {
                PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Right,
                    position: at,
                    modifiers: gpui::Modifiers::default(),
                    click_count: 1,
                })
            };
            self.input(event)?;
        }
        self.settle();
        Ok(())
    }

    /// `window <name>`: the whole window, for looking at an overlay that opens off the canvas.
    pub(super) fn window_shot(&mut self, name: &str) -> anyhow::Result<()> {
        let page = self.page.clone().context("no page open")?;
        let image = self.cx.capture_screenshot(self.handle)?;
        image.save(self.options.dir.join(format!("{page}.{name}.window.png")))?;
        Ok(())
    }

    /// `shot <name> [margin]`.
    pub(super) fn shot_command(&mut self, arg: &str) -> anyhow::Result<()> {
        let (name, margin) = arg.split_once(' ').unwrap_or((arg, ""));
        self.shot(name, margin.parse().unwrap_or(super::MARGIN))
    }

    /// `mark <anchor>`: remembers where the anchor is.
    pub(super) fn mark(&mut self, name: &str) -> anyhow::Result<()> {
        let bounds = self
            .cx
            .debug_bounds(self.handle, name)?
            .with_context(|| format!("no {name} on the page"))?;
        self.marks.insert(name.to_owned(), bounds);
        Ok(())
    }

    /// Records the story the pointer is on, when it is on one.
    pub(super) fn remember_owner(&mut self) {
        let names = self.names();
        for (index, _) in names.iter().enumerate() {
            if let Ok(bounds) = self.canvas(index, &names)
                && bounds.contains(&self.pointer)
            {
                self.owner = Some(index);
            }
        }
    }

    /// The story a shot crops around: the one under the pointer, else the last one pointed at.
    pub(super) fn story_of_pointer(
        &mut self,
        names: &[String],
    ) -> anyhow::Result<(usize, Bounds<gpui::Pixels>)> {
        for index in 0..names.len() {
            let bounds = self.canvas(index, names)?;
            if bounds.contains(&self.pointer) {
                return Ok((index, bounds));
            }
        }
        let index = match self.owner {
            Some(index) => index,
            None if self.pointer == Point::default() => 0,
            None => anyhow::bail!("the pointer is on no story canvas"),
        };
        Ok((index, self.canvas(index, names)?))
    }

    /// The open overlay's surface and its open submenu (logical px), for the geometry tables.
    pub(super) fn overlay_json(&mut self) -> anyhow::Result<serde_json::Value> {
        let mut found = Vec::new();
        for name in SURFACES {
            if let Some(b) = self.cx.debug_bounds(self.handle, name)? {
                found.push(serde_json::json!({
                    "name": name,
                    "x": b.origin.x.as_f32(), "y": b.origin.y.as_f32(),
                    "w": b.size.width.as_f32(), "h": b.size.height.as_f32(),
                }));
            }
        }
        Ok(match found.first() {
            Some(first) => {
                let mut first = first.clone();
                first["sub"] = found.get(1).cloned().unwrap_or(serde_json::Value::Null);
                first
            }
            None => serde_json::Value::Null,
        })
    }
}
