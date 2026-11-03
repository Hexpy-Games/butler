use crate::input::Page;
use cef::ImplBrowserHost;
use gpui::*;
use std::ops::Range;
impl EntityInputHandler for Page {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        *actual = Some(r.clone());
        let v = self.text.encode_utf16().collect::<Vec<_>>();
        String::from_utf16(v.get(r)?).ok()
    }
    fn selected_text_range(
        &mut self,
        _ignore: bool,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let r = if self.marked.is_some() {
            self.selection.clone()
        } else {
            self.rt.shared.borrow().selection.clone()
        };
        Some(UTF16Selection {
            range: r,
            reversed: false,
        })
    }
    fn marked_text_range(&self, _w: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone()
    }
    fn unmark_text(&mut self, _w: &mut Window, _cx: &mut Context<Self>) {
        if let Some(h) = self.rt.host() {
            h.ime_finish_composing_text(0);
        }
        self.marked = None;
    }
    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        new: &str,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        if let Some(h) = self.rt.host() {
            self.rt.input();
            let r = cef_range(r);
            h.ime_commit_text(Some(&new.into()), Some(&r), 0);
        }
        self.marked = None;
        self.text = new.to_string();
        self.selection = new.encode_utf16().count()..new.encode_utf16().count();
        crate::log("ime_commit", serde_json::json!({"text":new}));
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        new: &str,
        selected: Option<Range<usize>>,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        let n = new.encode_utf16().count();
        let selected = selected.unwrap_or(n..n);
        if let Some(h) = self.rt.host() {
            self.rt.input();
            let r = cef_range(r);
            let selection = cef_range(Some(selected.clone()));
            let underline = cef::CompositionUnderline {
                range: cef::Range {
                    from: 0,
                    to: n as u32,
                },
                color: 0xff000000,
                background_color: 0,
                thick: 0,
                ..Default::default()
            };
            h.ime_set_composition(
                Some(&new.into()),
                Some(&[underline]),
                Some(&r),
                Some(&selection),
            );
        }
        self.text = new.to_string();
        self.marked = Some(0..n);
        self.selection = selected;
        crate::log("ime_composition", serde_json::json!({"text":new}));
    }
    fn bounds_for_range(
        &mut self,
        r: Range<usize>,
        b: Bounds<Pixels>,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let s = self.rt.shared.borrow();
        let rect = s.ime_bounds.get(r.start).or_else(|| s.ime_bounds.last())?;
        Some(Bounds::new(
            b.origin + point(px(rect.x as f32), px(rect.y as f32)),
            size(px(rect.width.max(1) as f32), px(rect.height.max(1) as f32)),
        ))
    }
    fn character_index_for_point(
        &mut self,
        _p: Point<Pixels>,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.selection.end)
    }
}
fn cef_range(r: Option<Range<usize>>) -> cef::Range {
    r.map(|r| cef::Range {
        from: r.start as u32,
        to: r.end as u32,
    })
    .unwrap_or(cef::Range {
        from: u32::MAX,
        to: u32::MAX,
    })
}
