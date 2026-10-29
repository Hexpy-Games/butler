// Modified from zed's crates/gpui/examples/input.rs (Apache-2.0) by HexpyGames for Butler
// (2026); see THIRD-PARTY-NOTICES.
//! UTF-16 offsets (the platform's IME and accessibility unit) and the input handler.
use std::ops::Range;
use std::time::Instant;

use gpui::{Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window, point};

use super::TextInput;

impl TextInput {
    fn to_utf16(&self, offset: usize) -> usize {
        self.content[..offset.min(self.content.len())]
            .encode_utf16()
            .count()
    }
    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        for (i, ch) in self.content.char_indices() {
            if utf16 >= offset {
                return i;
            }
            utf16 += ch.len_utf16();
        }
        self.content.len()
    }
    fn range_to_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.to_utf16(r.start)..self.to_utf16(r.end)
    }
    fn range_from_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(r.start)..self.offset_from_utf16(r.end)
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&r);
        actual.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }
    fn set_selected_text_range(&mut self, r: Range<usize>, w: &mut Window, cx: &mut Context<Self>) {
        self.selected_range = self.range_from_utf16(&r);
        self.selection_reversed = false;
        w.invalidate_character_coordinates();
        cx.notify();
    }
    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.content.encode_utf16().count())
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|r| self.range_to_utf16(r))
    }
    fn unmark_text(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.marked_range = None;
        w.invalidate_character_coordinates();
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        new: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = r
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content =
            (self.content[..range.start].to_owned() + new + &self.content[range.end..]).into();
        self.selected_range = range.start + new.len()..range.start + new.len();
        self.selection_reversed = false;
        self.marked_range = None;
        self.last_edit = Instant::now();
        w.invalidate_character_coordinates();
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        new: &str,
        sel: Option<Range<usize>>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = r
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content =
            (self.content[..range.start].to_owned() + new + &self.content[range.end..]).into();
        self.marked_range = (!new.is_empty()).then(|| range.start..range.start + new.len());
        let start16 = self.to_utf16(range.start);
        let len16 = new.encode_utf16().count();
        self.selected_range = sel
            .map(|s| {
                self.range_from_utf16(&(start16 + s.start.min(len16)..start16 + s.end.min(len16)))
            })
            .unwrap_or_else(|| range.start + new.len()..range.start + new.len());
        self.selection_reversed = false;
        self.last_edit = Instant::now();
        w.invalidate_character_coordinates();
        cx.notify();
    }
    fn bounds_for_range(
        &mut self,
        r: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let range = self.range_from_utf16(&r);
        let a = layout.point_for(range.start)?;
        let b = layout.point_for(range.end).unwrap_or(a);
        let origin = bounds.origin - point(Pixels::ZERO, self.scroll_top);
        Some(Bounds::from_corners(
            origin + a,
            origin + point(b.x.max(a.x), a.y + layout.line_height),
        ))
    }
    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let layout = self.layout.as_ref()?;
        let local = p - layout.bounds.origin + point(Pixels::ZERO, self.scroll_top);
        Some(self.to_utf16(layout.offset_for(local, self.content.len())))
    }
}
