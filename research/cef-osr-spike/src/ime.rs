use crate::input::Page;
use cef::ImplBrowserHost;
use gpui::*;
use std::ops::Range;

impl Page {
    /// The selection in document offsets: inside a composition the bridge's own, otherwise CEF's.
    fn caret(&self) -> Range<usize> {
        if self.marked.is_some() {
            self.selection.clone()
        } else {
            self.rt.shared.borrow().selection.clone()
        }
    }
}

impl EntityInputHandler for Page {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let found = self.marked.as_ref().and_then(|m| {
            let o = r.start.max(m.start)..r.end.min(m.end);
            if o.is_empty() {
                return None;
            }
            let units = self.composition.encode_utf16().collect::<Vec<_>>();
            let text = String::from_utf16(units.get(o.start - m.start..o.end - m.start)?).ok()?;
            Some((o, text))
        });
        let (known, text) = found.unwrap_or((r.start..r.start, String::new()));
        crate::log(
            "ime_text_for_range",
            serde_json::json!({"range":[r.start,r.end],"answer":[[known.start,known.end],&text]}),
        );
        *actual = Some(known);
        Some(text)
    }
    fn selected_text_range(
        &mut self,
        _ignore: bool,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let r = self.caret();
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
        if let Some(m) = self.marked.take() {
            self.rt.shared.borrow_mut().selection = m.end..m.end;
        }
        self.composition.clear();
    }
    fn replace_text_in_range(
        &mut self,
        r: Option<Range<usize>>,
        new: &str,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        let start = r
            .as_ref()
            .or(self.marked.as_ref())
            .map_or_else(|| self.caret().start, |x| x.start);
        if let Some(h) = self.rt.host() {
            self.rt.input();
            let r = cef_range(r);
            h.ime_commit_text(Some(&new.into()), Some(&r), 0);
        }
        let end = start + new.encode_utf16().count();
        self.marked = None;
        self.composition.clear();
        self.selection = end..end;
        self.rt.shared.borrow_mut().selection = end..end;
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
        let start = r
            .as_ref()
            .or(self.marked.as_ref())
            .map_or_else(|| self.caret().start, |x| x.start);
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
        self.composition = new.to_string();
        self.marked = (n > 0).then_some(start..start + n);
        self.selection = start + selected.start..start + selected.end;
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
        let i = self
            .marked
            .as_ref()
            .and_then(|m| r.start.checked_sub(m.start));
        let rect = i
            .and_then(|i| s.ime_bounds.get(i))
            .or_else(|| s.ime_bounds.last())?;
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
        None
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
