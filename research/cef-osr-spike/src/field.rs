use gpui::{prelude::*, *};
use std::ops::Range;
pub struct Field {
    pub focus: FocusHandle,
    text: String,
    selection: Range<usize>,
    marked: Option<Range<usize>>,
}
impl Field {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            text: String::new(),
            selection: 0..0,
            marked: None,
        }
    }
    fn byte(&self, n: usize) -> usize {
        let mut count = 0;
        for (i, c) in self.text.char_indices() {
            if count >= n {
                return i;
            }
            count += c.len_utf16();
        }
        self.text.len()
    }
}
impl Render for Field {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let focus = self.focus.clone();
        div()
            .id("gpui-field")
            .track_focus(&self.focus)
            .border_2()
            .border_color(rgb(0x63c9ef))
            .p_3()
            .min_h(px(46.))
            .child(if self.text.is_empty() {
                "GPUI field".to_string()
            } else {
                self.text.clone()
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, _, w, cx| {
                    w.focus(&s.focus, cx);
                    super::log("gpui_field_focus", serde_json::json!(true));
                }),
            )
            .child(
                canvas(
                    |b, _, _| b,
                    move |_, b, w, cx| {
                        w.handle_input(&focus, ElementInputHandler::new(b, entity.clone()), cx);
                    },
                )
                .size_full(),
            )
    }
}
impl EntityInputHandler for Field {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        *actual = Some(r.clone());
        Some(self.text[self.byte(r.start)..self.byte(r.end)].to_string())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.selection.clone(),
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone()
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }
    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        new: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let r = r.or(self.marked.take()).unwrap_or(self.selection.clone());
        self.text
            .replace_range(self.byte(r.start)..self.byte(r.end), new);
        let end = r.start + new.encode_utf16().count();
        self.selection = end..end;
        super::log("gpui_field_input", serde_json::json!({"text":self.text}));
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
        let start = r
            .as_ref()
            .or(self.marked.as_ref())
            .unwrap_or(&self.selection)
            .start;
        self.replace_text_in_range(r, new, w, cx);
        self.marked = Some(start..start + new.encode_utf16().count());
        if let Some(sel) = sel {
            self.selection = start + sel.start..start + sel.end;
        }
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        b: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(b)
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.selection.end)
    }
}
