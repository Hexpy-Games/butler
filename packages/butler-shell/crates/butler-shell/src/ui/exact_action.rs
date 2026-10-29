//! Code text wraps only at whitespace, then at Unicode boundaries for oversized tokens.
//! Layout slices the original string; no hyphen substitution or inserted text.
use crate::ui::theme::Theme;
use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, ShapedText, SharedString, Style, TextAlign, TextRun, Window,
    font, point, px, relative, size,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone)]
pub(crate) struct ExactAction {
    text: SharedString,
    theme: Theme,
    font_size: f32,
    line_height: f32,
    cache: RowsCache,
}

#[derive(Clone)]
pub(crate) struct Row {
    text: Rc<ShapedText>,
    continuation: bool,
}
#[derive(Clone)]
struct CachedRows {
    width: Pixels,
    text: SharedString,
    dark: bool,
    font: SharedString,
    font_size: f32,
    rows: Vec<Row>,
}
type RowsCache = Rc<RefCell<Option<CachedRows>>>;
pub(crate) fn exact_action(text: SharedString, theme: &Theme, scale: f32) -> ExactAction {
    ExactAction {
        text,
        theme: theme.clone(),
        font_size: 13. * scale,
        line_height: 18. * scale,
        cache: Rc::default(),
    }
}
impl IntoElement for ExactAction {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl ExactAction {
    fn shape(&self, text: &str, window: &mut Window) -> Option<Rc<ShapedText>> {
        let run = TextRun {
            len: text.len(),
            font: font(self.theme.code_font.clone()),
            color: self.theme.text,
            ..Default::default()
        };
        window
            .text_system()
            .shape_text(text.to_owned(), px(self.font_size), &[run], None, None)
            .ok()
            .map(Rc::new)
    }
    fn rows(&self, width: Pixels, window: &mut Window) -> Vec<Row> {
        if let Some(cached) = self.cache.borrow().as_ref()
            && cached.width == width
            && cached.text == self.text
            && cached.dark == self.theme.dark
            && cached.font == self.theme.code_font
            && cached.font_size == self.font_size
        {
            return cached.rows.clone();
        }
        let width = (width - px(12.)).max(px(1.));
        let mut rows = Vec::new();
        for line in self.text.split('\n') {
            let mut rest = line;
            let mut continuation = false;
            while !rest.is_empty() {
                let Some(shaped) = self.shape(rest, window) else {
                    break;
                };
                if shaped.width() <= width {
                    rows.push(Row {
                        text: shaped,
                        continuation,
                    });
                    break;
                }
                let hit = shaped.closest_byte_index_for_pixel_point(
                    point(width, Pixels::ZERO),
                    px(self.line_height),
                );
                let end = hit.unwrap_or_else(|i| i).min(rest.len());
                let end = break_at(rest, end);
                if let Some(row) = self.shape(&rest[..end], window) {
                    rows.push(Row {
                        text: row,
                        continuation,
                    });
                }
                continuation = !rest[..end].ends_with(char::is_whitespace)
                    && !rest[end..].starts_with(char::is_whitespace);
                rest = &rest[end..];
            }
            if line.is_empty()
                && let Some(row) = self.shape("", window)
            {
                rows.push(Row {
                    text: row,
                    continuation: false,
                });
            }
        }
        *self.cache.borrow_mut() = Some(CachedRows {
            width: width + px(12.),
            text: self.text.clone(),
            dark: self.theme.dark,
            font: self.theme.code_font.clone(),
            font_size: self.font_size,
            rows: rows.clone(),
        });
        rows
    }
}
impl Element for ExactAction {
    type RequestLayoutState = ();
    type PrepaintState = Vec<Row>;
    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Name(self.text.clone()))
    }
    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        if let Some(id) = id {
            self.cache = window.with_element_state(id, |cache: Option<RowsCache>, _| {
                let cache = cache.unwrap_or_default();
                (cache.clone(), cache)
            });
        }
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let action = self.clone();
        let id = window.request_measured_layout(style, move |known, available, window, _| {
            let width = known.width.unwrap_or_else(|| match available.width {
                AvailableSpace::Definite(w) => w,
                _ => px(480.),
            });
            size(
                width,
                px(action.rows(width, window).len() as f32 * action.line_height),
            )
        });
        (id, ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        window: &mut Window,
        _: &mut App,
    ) -> Vec<Row> {
        self.rows(bounds.size.width, window)
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        (): &mut (),
        rows: &mut Vec<Row>,
        window: &mut Window,
        cx: &mut App,
    ) {
        for (i, row) in rows.iter().enumerate() {
            let origin = bounds.origin + point(Pixels::ZERO, px(i as f32 * self.line_height));
            if row.continuation
                && let Some(mark) = self.shape("↪", window)
            {
                let _ = mark.paint(
                    origin,
                    px(self.line_height),
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
            let _ = row.text.paint(
                origin + point(px(12.), Pixels::ZERO),
                px(self.line_height),
                TextAlign::Left,
                None,
                window,
                cx,
            );
        }
    }
}

/// Whitespace owns ordinary wraps; oversized tokens retain their hyphens.
fn break_at(rest: &str, end: usize) -> usize {
    let mut end = rest[..end].rfind(char::is_whitespace).map_or(end, |i| {
        i + rest[i..].chars().next().map_or(0, char::len_utf8)
    });
    // A forced split cannot touch either side of a hyphen. If the
    // entire hyphen run exceeds the row, preserve it and overflow.
    let safe = |i: usize| {
        rest[..i].ends_with(char::is_whitespace)
            || rest[i..].starts_with(char::is_whitespace)
            || (!rest[..i].ends_with('-') && !rest[i..].starts_with('-'))
    };
    while end > 0 && !safe(end) {
        end = rest[..end].char_indices().next_back().map_or(0, |(i, _)| i);
    }
    if end == 0 {
        end = rest
            .char_indices()
            .map(|(i, _)| i)
            .skip(1)
            .find(|&i| safe(i))
            .unwrap_or(rest.len());
    }
    end
}
