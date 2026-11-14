use std::ops::Range;

/// Text queries use document UTF-16 offsets. CEF's composition selection input is relative.
#[derive(Clone, Default, Debug)]
pub struct OsrIme {
    pub marked: Option<Range<u32>>,
    pub composition: String,
    pub selection: Range<u32>,
    pub(super) document_selection: Range<u32>,
}
impl OsrIme {
    pub fn selected_text_range(&self) -> Range<u32> {
        if self.marked.is_some() {
            self.selection.clone()
        } else {
            self.document_selection.clone()
        }
    }
    pub fn text_for_range(&self, range: Range<u32>) -> (Range<u32>, String) {
        let found = self.marked.as_ref().and_then(|marked| {
            let overlap = range.start.max(marked.start)..range.end.min(marked.end);
            if overlap.is_empty() {
                return None;
            }
            let units: Vec<_> = self.composition.encode_utf16().collect();
            let start = usize::try_from(overlap.start - marked.start).ok()?;
            let end = usize::try_from(overlap.end - marked.start).ok()?;
            let text = String::from_utf16(units.get(start..end)?).ok()?;
            Some((overlap, text))
        });
        found.unwrap_or((range.start..range.start, String::new()))
    }
    pub fn character_index_for_point(&self, _x: i32, _y: i32) -> Option<u32> {
        None
    }
}
