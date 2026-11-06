//! The page-scrolling commands of the live harness: `scroll` and `scrollto`.
use anyhow::Context as _;
use gpui::{
    Bounds, Modifiers, PlatformInput, ScrollDelta, ScrollWheelEvent, TouchPhase, point, px,
};

use super::Live;
use crate::app::DsView;

impl Live {
    /// The wheel over the middle of story `n`'s canvas (`@name`: over that anchor), `dx`/`dy` px
    /// further along its content.
    pub(super) fn scroll(&mut self, arg: &str) -> anyhow::Result<()> {
        let mut parts = arg.split_whitespace();
        let target = parts.next().context("scroll <story|@anchor> <dx> <dy>")?;
        let mut next = || -> anyhow::Result<f32> {
            Ok(parts
                .next()
                .context("scroll <story|@anchor> <dx> <dy>")?
                .parse()?)
        };
        let (dx, dy) = (next()?, next()?);
        let anchor = match target.strip_prefix('@') {
            Some(name) => name.to_owned(),
            None => {
                let story: usize = target.parse()?;
                let names = self.cx.update(|app| {
                    self.window
                        .read(app)
                        .map(DsView::story_names)
                        .unwrap_or_default()
                });
                let name = names
                    .get(story)
                    .with_context(|| format!("no story {story}"))?;
                format!("story-{name}")
            }
        };
        let at = self
            .cx
            .debug_bounds(self.handle, &anchor)?
            .with_context(|| format!("no {anchor} on the page"))?
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

    /// Scrolls the page by the wheel so story `n`'s canvas top lands `top` px from the window top.
    pub(super) fn scroll_to(&mut self, arg: &str) -> anyhow::Result<()> {
        let mut parts = arg.split_whitespace();
        let mut next = || -> anyhow::Result<f32> {
            Ok(parts.next().context("scrollto <story> <top>")?.parse()?)
        };
        let (story, top) = (next()?, next()?);
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
        let bounds = self
            .cx
            .debug_bounds(self.handle, &format!("story-{name}"))?
            .with_context(|| format!("no canvas for story {name}"))?;
        let delta = bounds.origin.y.as_f32() - top;
        // The wheel goes over the page's middle, which is on screen whatever the story's place.
        let window = self
            .cx
            .update_window(self.handle, |_, w, _| w.viewport_size())?;
        let over = point(window.width * 0.75, window.height * 0.5);
        self.move_to(over)?;
        self.input(PlatformInput::ScrollWheel(ScrollWheelEvent {
            position: over,
            delta: ScrollDelta::Pixels(point(px(0.), px(-delta))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        }))?;
        self.settle();
        // The pointer ends on the part of the story that is on screen, so `shot` finds it.
        let bounds = self
            .cx
            .debug_bounds(self.handle, &format!("story-{name}"))?
            .with_context(|| format!("no canvas for story {name}"))?;
        let screen = Bounds::new(point(px(0.), px(0.)), window);
        self.move_to(bounds.intersect(&screen).center())?;
        Ok(())
    }
}
