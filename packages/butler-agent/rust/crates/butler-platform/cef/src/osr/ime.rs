use super::{OsrIme, OsrRuntime};
use cef::ImplBrowserHost;
use std::ops::Range;

impl OsrRuntime {
    pub fn ime(&self, page: u64) -> Option<OsrIme> {
        self.page(page).map(|p| p.borrow().ime.clone())
    }

    /// `selection` is in UTF-16 offsets relative to `text`, as required by CEF.
    pub fn ime_set_composition(&self, page: u64, text: &str, selection: Range<u32>) {
        let Some(p) = self.page(page) else {
            return;
        };
        let Ok(length) = u32::try_from(text.encode_utf16().count()) else {
            return;
        };
        {
            let mut p = p.borrow_mut();
            let ime = &mut p.ime;
            let start = ime
                .marked
                .as_ref()
                .map_or_else(|| ime.selected_text_range().start, |m| m.start);
            ime.composition = text.to_owned();
            ime.marked = (length > 0).then_some(start..start.saturating_add(length));
            ime.selection =
                start.saturating_add(selection.start)..start.saturating_add(selection.end);
        }
        if let Some(h) = self.host(page) {
            let underline = cef::CompositionUnderline {
                range: cef::Range {
                    from: 0,
                    to: length,
                },
                color: 0xff00_0000,
                ..Default::default()
            };
            h.ime_set_composition(
                Some(&text.into()),
                Some(&[underline]),
                Some(&invalid_range()),
                Some(&cef::Range {
                    from: selection.start,
                    to: selection.end,
                }),
            );
        }
    }
    pub fn ime_commit(&self, page: u64, text: &str) {
        let Some(p) = self.page(page) else {
            return;
        };
        let Ok(length) = u32::try_from(text.encode_utf16().count()) else {
            return;
        };
        {
            let mut p = p.borrow_mut();
            let ime = &mut p.ime;
            let start = ime
                .marked
                .as_ref()
                .map_or_else(|| ime.selected_text_range().start, |m| m.start);
            let end = start.saturating_add(length);
            ime.marked = None;
            ime.composition.clear();
            ime.selection = end..end;
            ime.document_selection = end..end;
        }
        if let Some(h) = self.host(page) {
            h.ime_commit_text(Some(&text.into()), Some(&invalid_range()), 0);
        }
    }
    pub fn ime_cancel(&self, page: u64) {
        if let Some(p) = self.page(page) {
            let mut p = p.borrow_mut();
            p.ime.marked = None;
            p.ime.composition.clear();
        }
        if let Some(h) = self.host(page) {
            h.ime_cancel_composition();
        }
    }
}
fn invalid_range() -> cef::Range {
    cef::Range {
        from: u32::MAX,
        to: u32::MAX,
    }
}
