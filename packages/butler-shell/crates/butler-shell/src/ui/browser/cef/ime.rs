//! Native text queries use document UTF-16 offsets, including composition overlaps.
use super::super::agent_host::Input;
use super::surface::{Page, range};
use gpui::{
    Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window, point, px, size,
};
use std::ops::Range;

impl EntityInputHandler for Page {
    fn text_for_range(
        &mut self,
        requested: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let ime = self.runtime.upgrade()?.ime(self.id)?;
        let (found, text) = ime.text_for_range(cef_range(requested)?);
        *actual = Some(range(found));
        Some(text)
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let ime = self.runtime.upgrade()?.ime(self.id)?;
        Some(UTF16Selection {
            range: range(ime.selected_text_range()),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.runtime.upgrade()?.ime(self.id)?.marked.map(range)
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(runtime) = self.runtime.upgrade()
            && let Some(ime) = runtime.ime(self.id)
            && ime.marked.is_some()
            && self.admit(Input::Press, cx)
        {
            runtime.ime_commit(self.id, &ime.composition);
        }
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.admit(Input::Press, cx)
            && let Some(runtime) = self.runtime.upgrade()
        {
            runtime.ime_commit(self.id, text);
        }
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let length = text.encode_utf16().count();
        if self.admit(Input::Press, cx)
            && let Some(runtime) = self.runtime.upgrade()
            && let Some(selected) = cef_range(selected.unwrap_or(length..length))
        {
            runtime.ime_set_composition(self.id, text, selected);
        }
    }
    fn bounds_for_range(
        &mut self,
        requested: Range<usize>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let ime = self.runtime.upgrade()?.ime(self.id)?;
        let start = usize::try_from(ime.marked?.start).ok()?;
        let state = self.state.borrow();
        let rect = state
            .ime_bounds
            .get(requested.start.saturating_sub(start))
            .or_else(|| state.ime_bounds.last())?;
        // CEF reports page pixels; the window works in content pixels.
        let zoom = window.zoom();
        Some(Bounds::new(
            bounds.origin + point(px(rect.x as f32 / zoom), px(rect.y as f32 / zoom)),
            size(
                px(rect.width.max(1) as f32 / zoom),
                px(rect.height.max(1) as f32 / zoom),
            ),
        ))
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}
fn cef_range(range: Range<usize>) -> Option<Range<u32>> {
    Some(u32::try_from(range.start).ok()?..u32::try_from(range.end).ok()?)
}
