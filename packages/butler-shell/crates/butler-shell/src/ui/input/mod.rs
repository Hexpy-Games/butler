// Modified from zed's crates/gpui/examples/input.rs (Apache-2.0) by HexpyGames for Butler
// (2026); see THIRD-PARTY-NOTICES.
//! Multi-line, IME-capable text input, adapted from zed's crates/gpui/examples/input.rs
//! (Apache-2.0; see THIRD-PARTY-NOTICES) by way of the gpui spike: text is wrapped with
//! `shape_text` so Shift+Enter lines and soft wraps both work.
mod element;
mod ime;

use std::ops::Range;
use std::time::Instant;

use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, EntityInputHandler, FocusHandle, Focusable,
    Hsla, KeyBinding, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    ShapedText, SharedString, Window, actions, div, point, prelude::*,
};
use unicode_segmentation::UnicodeSegmentation;

actions!(
    text_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Cut,
        Copy,
        Newline
    ]
);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    let c = Some("TextInput");
    vec![
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("secondary-a", SelectAll, c),
        KeyBinding::new("secondary-v", Paste, c),
        KeyBinding::new("secondary-c", Copy, c),
        KeyBinding::new("secondary-x", Cut, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new("shift-enter", Newline, c),
    ]
}

pub(crate) struct InputColors {
    pub(crate) text: Hsla,
    pub(crate) placeholder: Hsla,
    pub(crate) selection: Hsla,
}

/// The last painted layout: the whole text shaped and wrapped as one block.
pub(crate) struct Layout {
    pub(crate) text: Option<ShapedText>,
    pub(crate) bounds: Bounds<Pixels>,
    pub(crate) line_height: Pixels,
}

pub(crate) struct TextInput {
    pub(crate) focus_handle: FocusHandle,
    pub(crate) content: SharedString,
    pub(crate) placeholder: SharedString,
    pub(crate) selected_range: Range<usize>,
    selection_reversed: bool,
    pub(crate) marked_range: Option<Range<usize>>,
    pub(crate) layout: Option<Layout>,
    pub(crate) scroll_top: Pixels,
    pub(crate) last_edit: Instant,
    pub(crate) colors: InputColors,
    is_selecting: bool,
}

impl TextInput {
    pub(crate) fn new(placeholder: &str, colors: InputColors, cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: "".into(),
            placeholder: placeholder.to_string().into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            layout: None,
            scroll_top: Pixels::ZERO,
            last_edit: Instant::now(),
            colors,
            is_selecting: false,
        }
    }

    pub(crate) fn text(&self) -> SharedString {
        self.content.clone()
    }
    pub(crate) fn is_composing(&self) -> bool {
        self.marked_range.is_some()
    }
    pub(crate) fn set_placeholder(&mut self, s: &str) {
        self.placeholder = s.to_string().into();
    }
    pub(crate) fn set_colors(&mut self, colors: InputColors) {
        self.colors = colors;
    }

    pub(crate) fn reset(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.content = "".into();
        self.selected_range = 0..0;
        self.selection_reversed = false;
        self.marked_range = None;
        self.scroll_top = Pixels::ZERO;
        window.invalidate_character_coordinates();
        cx.notify();
    }

    pub(crate) fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn move_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.last_edit = Instant::now();
        window.invalidate_character_coordinates();
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        window.invalidate_character_coordinates();
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < offset).then_some(i))
            .unwrap_or(0)
    }
    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(i, _)| (i > offset).then_some(i))
            .unwrap_or(self.content.len())
    }

    fn left(&mut self, _: &Left, w: &mut Window, cx: &mut Context<Self>) {
        let to = if self.selected_range.is_empty() {
            self.previous_boundary(self.cursor_offset())
        } else {
            self.selected_range.start
        };
        self.move_to(to, w, cx);
    }
    fn right(&mut self, _: &Right, w: &mut Window, cx: &mut Context<Self>) {
        let to = if self.selected_range.is_empty() {
            self.next_boundary(self.selected_range.end)
        } else {
            self.selected_range.end
        };
        self.move_to(to, w, cx);
    }
    fn vertical(&mut self, dir: f32, w: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = &self.layout else { return };
        let Some(p) = layout.point_for(self.cursor_offset()) else {
            return;
        };
        let target = point(
            p.x,
            p.y + layout.line_height * dir + layout.line_height / 2.,
        );
        let to = layout.offset_for(target, self.content.len());
        self.move_to(to, w, cx);
    }
    fn up(&mut self, _: &Up, w: &mut Window, cx: &mut Context<Self>) {
        self.vertical(-1., w, cx);
    }
    fn down(&mut self, _: &Down, w: &mut Window, cx: &mut Context<Self>) {
        self.vertical(1., w, cx);
    }
    fn select_left(&mut self, _: &SelectLeft, w: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), w, cx);
    }
    fn select_right(&mut self, _: &SelectRight, w: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), w, cx);
    }
    fn select_all(&mut self, _: &SelectAll, w: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, w, cx);
        self.select_to(self.content.len(), w, cx);
    }
    fn line_edge(&self, end: bool) -> usize {
        let c = self.cursor_offset();
        if end {
            self.content[c..]
                .find('\n')
                .map(|i| c + i)
                .unwrap_or(self.content.len())
        } else {
            self.content[..c].rfind('\n').map(|i| i + 1).unwrap_or(0)
        }
    }
    fn home(&mut self, _: &Home, w: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_edge(false), w, cx);
    }
    fn end(&mut self, _: &End, w: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_edge(true), w, cx);
    }
    fn backspace(&mut self, _: &Backspace, w: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let prev = self.previous_boundary(self.cursor_offset());
            if prev == self.cursor_offset() {
                return;
            }
            self.select_to(prev, w, cx);
        }
        self.replace_text_in_range(None, "", w, cx);
    }
    fn delete(&mut self, _: &Delete, w: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            if next == self.cursor_offset() {
                return;
            }
            self.select_to(next, w, cx);
        }
        self.replace_text_in_range(None, "", w, cx);
    }
    fn newline(&mut self, _: &Newline, w: &mut Window, cx: &mut Context<Self>) {
        if !self.is_composing() {
            self.replace_text_in_range(None, "\n", w, cx);
        }
    }
    fn paste(&mut self, _: &Paste, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text.replace("\r\n", "\n"), w, cx);
        }
    }
    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }
    fn cut(&mut self, _: &Cut, w: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", w, cx);
        }
    }

    fn index_for_mouse(&self, position: Point<Pixels>) -> usize {
        match &self.layout {
            Some(layout) if !self.content.is_empty() => {
                let local = position - layout.bounds.origin + point(Pixels::ZERO, self.scroll_top);
                layout.offset_for(local, self.content.len())
            }
            _ => 0,
        }
    }
    fn on_mouse_down(&mut self, e: &MouseDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.is_selecting = true;
        let i = self.index_for_mouse(e.position);
        if e.modifiers.shift {
            self.select_to(i, w, cx);
        } else {
            self.move_to(i, w, cx);
        }
    }
    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }
    fn on_mouse_move(&mut self, e: &MouseMoveEvent, w: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse(e.position), w, cx);
        }
    }
}

impl Layout {
    /// Visual lines, including soft wraps.
    pub(crate) fn line_count(&self) -> usize {
        self.text.as_ref().map_or(1, |t| t.line_count().max(1))
    }
    pub(crate) fn height(&self) -> Pixels {
        self.line_height * self.line_count()
    }
    /// Cursor position relative to the text origin (unscrolled).
    pub(crate) fn point_for(&self, offset: usize) -> Option<Point<Pixels>> {
        self.text
            .as_ref()?
            .visual_position_for_byte_index(offset, self.line_height)
    }
    pub(crate) fn offset_for(&self, p: Point<Pixels>, len: usize) -> usize {
        if p.y < Pixels::ZERO {
            return 0;
        }
        if p.y >= self.height() {
            return len;
        }
        let Some(text) = &self.text else { return len };
        match text
            .closest_byte_index_for_pixel_point(point(p.x.max(Pixels::ZERO), p.y), self.line_height)
        {
            Ok(i) | Err(i) => i.min(len),
        }
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TextInput {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .key_context("TextInput")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .w_full()
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(element::TextElement { input: cx.entity() })
    }
}
